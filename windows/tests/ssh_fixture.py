"""Exercise Span on a loopback-only SSH server using disposable host and client keys."""

import base64
import contextlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import queue
import socketserver
import subprocess
import sys
import tempfile
import threading

import paramiko
from wsproto import ConnectionType, WSConnection
from wsproto.events import AcceptConnection, Request, TextMessage


STDIO_HOST = "span-ci-stdio"
SHARED_HOST = "span-ci-shared"


class Session(paramiko.ServerInterface):
    def __init__(self, key):
        self.key = key
        self.shared = False
        self.request = queue.Queue()

    def get_allowed_auths(self, username):
        return "publickey"

    def check_auth_publickey(self, username, key):
        if username in (STDIO_HOST, SHARED_HOST) and key == self.key:
            self.shared = username == SHARED_HOST
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        if kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(self, channel, term, width, height, pixelwidth, pixelheight, modes):
        return True

    def check_channel_shell_request(self, channel):
        self.request.put_nowait("shell")
        return True

    def check_channel_exec_request(self, channel, command):
        if b"exec codex app-server" not in command:
            return False
        self.request.put_nowait("codex")
        return True


class Files(paramiko.SFTPServerInterface):
    def __init__(self, server, root):
        super().__init__(server)
        self.root = root

    def canonicalize(self, path):
        return posixpath.normpath(posixpath.join("/workspace", path))

    def path(self, path):
        parts = PurePosixPath(self.canonicalize(path)).parts
        if parts[:2] != ("/", "workspace") or any(":" in part or "\\" in part for part in parts):
            raise PermissionError("outside the fixture workspace")
        return self.root.joinpath(*parts[2:])

    def list_folder(self, path):
        try:
            entries = []
            for file in self.path(path).iterdir():
                attrs = paramiko.SFTPAttributes.from_stat(file.stat(), filename=file.name)
                entries.append(attrs)
            return entries
        except PermissionError:
            return paramiko.SFTP_PERMISSION_DENIED
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def open(self, path, flags, attr):
        try:
            target = self.path(path)
            handle = paramiko.SFTPHandle(flags)
            mode = "wb" if flags & os.O_WRONLY else "rb"
            with_binary = flags | getattr(os, "O_BINARY", 0)
            file = os.fdopen(os.open(target, with_binary, 0o600), mode)
            if flags & os.O_WRONLY:
                handle.writefile = file
            else:
                handle.readfile = file
            return handle
        except PermissionError:
            return paramiko.SFTP_PERMISSION_DENIED
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def rename(self, oldpath, newpath):
        try:
            destination = self.path(newpath)
            if destination.exists():
                return paramiko.SFTP_FAILURE
            self.path(oldpath).rename(destination)
            return paramiko.SFTP_OK
        except PermissionError:
            return paramiko.SFTP_PERMISSION_DENIED
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def remove(self, path):
        try:
            self.path(path).unlink()
            return paramiko.SFTP_OK
        except PermissionError:
            return paramiko.SFTP_PERMISSION_DENIED
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        with paramiko.Transport(self.request) as transport:
            transport.add_server_key(self.server.host_key)
            transport.set_subsystem_handler("sftp", paramiko.SFTPServer, Files, root=self.server.root)
            session = Session(self.server.client_key)
            transport.start_server(server=session)
            channel = transport.accept(10)
            if channel is None:
                return
            with channel:
                while transport.is_active() and not channel.closed:
                    try:
                        action = session.request.get(timeout=0.1)
                    except queue.Empty:
                        continue  # The SFTP handler owns subsystem requests.
                    channel.settimeout(10)
                    if action == "shell":
                        shell(channel)
                    elif session.shared:
                        codex_shared(channel)
                    else:
                        codex_stdio(channel)
                    break


def shell(channel):
    channel.sendall(b"span-ssh-ready\r\n")
    received = b""
    while chunk := channel.recv(256):
        received += chunk
        if b"span-ping\n" in received.replace(b"\r", b"\n"):
            channel.sendall(b"span-ssh-pong\r\n")
            channel.send_exit_status(7)
            return
        if len(received) > 4096:
            raise AssertionError("unexpected terminal input")


def response(data, route):
    request = json.loads(data)
    if request["method"] == "initialize":
        result = {"userAgent": "span-ssh-fixture", "route": route}
    elif request["method"] == "thread/list":
        result = {"data": [{"id": "loopback-thread"}]}
    else:
        raise AssertionError(f"unexpected fixture request: {request['method']}")
    return json.dumps({"id": request["id"], "result": result})


def codex_stdio(channel):
    channel.sendall(b"span-codex-stdio\n")
    with channel.makefile("rb") as stdin:
        for line in stdin:
            channel.sendall((response(line, "stdio") + "\n").encode())


def codex_shared(channel):
    channel.sendall(b"span-codex-shared\n")
    websocket = WSConnection(ConnectionType.SERVER)
    parts = []
    while chunk := channel.recv(4096):
        websocket.receive_data(chunk)
        for event in websocket.events():
            if isinstance(event, Request):
                channel.sendall(websocket.send(AcceptConnection()))
            if isinstance(event, TextMessage):
                parts.append(event.data)
                if event.message_finished:
                    reply = TextMessage(data=response("".join(parts), "shared"))
                    channel.sendall(websocket.send(reply))
                    parts.clear()


@contextlib.contextmanager
def client_config(folder, port, host_key):
    profile = Path(os.environ["USERPROFILE"]) / ".ssh"
    profile.mkdir(exist_ok=True)
    configuration = profile / "config"
    previous = configuration.read_bytes() if configuration.exists() else None
    known_hosts = folder / "known_hosts"
    known_hosts.write_text(
        f"[127.0.0.1]:{port} {host_key.get_name()} {host_key.get_base64()}\n", encoding="ascii"
    )
    configuration.write_text(
        f"Host {STDIO_HOST}\n"
        f"    User {STDIO_HOST}\n"
        f"Host {SHARED_HOST}\n"
        f"    User {SHARED_HOST}\n"
        f"Host {STDIO_HOST} {SHARED_HOST}\n"
        "    HostName 127.0.0.1\n"
        f"    Port {port}\n"
        f'    IdentityFile "{(folder / "client").as_posix()}"\n'
        f'    UserKnownHostsFile "{known_hosts.as_posix()}"\n'
        "    IdentitiesOnly yes\n"
        "    BatchMode yes\n"
        "    ConnectTimeout 5\n"
        "    StrictHostKeyChecking yes\n",
        encoding="utf-8",
    )
    try:
        yield
    finally:
        if previous is None:
            configuration.unlink()
        else:
            configuration.write_bytes(previous)


def main(command):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("Run this fixture on an isolated GitHub Actions Windows runner.")
    with tempfile.TemporaryDirectory(prefix="span ssh ", dir=os.environ["RUNNER_TEMP"]) as folder:
        folder = Path(folder)
        subprocess.run(
            ["ssh-keygen.exe", "-q", "-t", "ed25519", "-N", "", "-f", str(folder / "client")],
            check=True,
            timeout=15,
        )
        kind, public, *_ = (folder / "client.pub").read_text(encoding="ascii").split()
        root = folder / "workspace"
        root.mkdir()
        (root / "notes").mkdir()
        (root / "样例.md").write_bytes(b"# Span loopback\n")
        with socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler) as server:
            server.daemon_threads = True
            server.host_key = paramiko.RSAKey.generate(2048)
            server.client_key = paramiko.PKey.from_type_string(kind, base64.b64decode(public))
            server.root = root
            port = server.server_address[1]
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                with client_config(folder, port, server.host_key):
                    env = dict(
                        os.environ,
                        SPAN_TEST_SSH_HOST=f"{STDIO_HOST}:{port}",
                        SPAN_TEST_SSH_SHARED_HOST=SHARED_HOST,
                        SPAN_TEST_SSH_DIR=str(folder),
                    )
                    subprocess.run(command, env=env, check=True, timeout=110)
                    assert not list(root.glob(".span-upload-*")), "staging files were left behind"
            finally:
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    main(sys.argv[1:])
