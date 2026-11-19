#!/usr/bin/env bash
set -euo pipefail

fixture="$(mktemp -d)"
codex_daemon_pid=
cleanup() {
    local result="$1"
    if [[ $result -ne 0 && -f "$fixture/sshd.log" ]]; then
        cat "$fixture/sshd.log" >&2
        if [[ -f "$fixture/unexpected-command" ]]; then
            cat "$fixture/unexpected-command" >&2
        fi
    fi
    ssh -F /dev/null -S "$fixture/control" -O exit localhost 2>/dev/null || true
    if [[ -f "$fixture/sshd.pid" ]]; then
        sudo kill "$(cat "$fixture/sshd.pid")" 2>/dev/null || true
    fi
    if [[ -n "$codex_daemon_pid" ]]; then
        kill "$codex_daemon_pid" 2>/dev/null || true
        wait "$codex_daemon_pid" 2>/dev/null || true
    fi
    rm -rf -- "$fixture"
}
trap 'cleanup "$?"' EXIT

port="$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
)"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/host"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/client"
mkdir -p "$fixture/files/folder"
printf 'abc' > "$fixture/files/a sample.txt"
chmod 640 "$fixture/files/a sample.txt"
touch "$fixture/files/.hidden"
cat > "$fixture/sshd_config" <<CONFIG
ListenAddress 127.0.0.1:$port
HostKey $fixture/host
PidFile $fixture/sshd.pid
AuthorizedKeysFile $fixture/client.pub
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
Subsystem sftp /usr/lib/openssh/sftp-server
CONFIG

if [[ ${WORKBENCH_TEST_AGENT_SSH:-} == 1 ]]; then
    fixture_codex_home="$fixture/codex state"
    install -Dm0755 packaging/test-agent.py "$fixture/bin/codex"
    HOME="$fixture" CODEX_HOME="$fixture_codex_home" /usr/bin/python3 "$fixture/bin/codex" serve-shared &
    codex_daemon_pid=$!
    for _ in {1..100}; do
        if [[ -S "$fixture_codex_home/app-server-control/app-server-control.sock" ]]; then
            break
        fi
        kill -0 "$codex_daemon_pid"
        sleep 0.1
    done
    test -S "$fixture_codex_home/app-server-control/app-server-control.sock"

    cat > "$fixture/remote-command" <<SCRIPT
#!/usr/bin/env bash
export HOME='$fixture'
export CODEX_HOME='$fixture_codex_home'
export PATH='$fixture/bin':"\$PATH"
case \${SSH_ORIGINAL_COMMAND:-} in
    '')
        printf '%s\n' "\$\$" >> '$fixture/remote-shells'
        exec /bin/bash --noprofile --norc -i
        ;;
    "bash -lc '"*"'")
        exec /bin/bash -c "\${SSH_ORIGINAL_COMMAND:10:-1}"
        ;;
    '/usr/lib/openssh/sftp-server'|'/usr/lib/openssh/sftp-server ')
        exec /usr/lib/openssh/sftp-server
        ;;
    *)
        printf 'Unexpected remote command: %q\n' "\$SSH_ORIGINAL_COMMAND" >> '$fixture/unexpected-command'
        exit 1
        ;;
esac
SCRIPT
    chmod 700 "$fixture/remote-command"
    printf 'ForceCommand %s/remote-command\n' "$fixture" >> "$fixture/sshd_config"
fi

sudo install -d -m 0755 /run/sshd
touch "$fixture/sshd.log"
sudo /usr/sbin/sshd -f "$fixture/sshd_config" -E "$fixture/sshd.log"
if [[ ${WORKBENCH_TEST_AGENT_SSH:-} == 1 ]]; then
    WORKBENCH_SSH_FIXTURE="$fixture" WORKBENCH_SSH_PORT="$port" WORKBENCH_SSH_USER="$(id -un)" \
        ssh-agent bash -c 'ssh-add "$WORKBENCH_SSH_FIXTURE/client" && exec "$@"' bash "$@"
    exit
fi
ssh -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 \
    -i "$fixture/client" -M -S "$fixture/control" -fN -p "$port" "$(id -un)@127.0.0.1"
WORKBENCH_TEST_SFTP_SOCKET="$fixture/control" WORKBENCH_TEST_SFTP_DIRECTORY="$fixture/files" "$@"
