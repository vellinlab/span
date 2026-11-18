#!/usr/bin/env bash
set -euo pipefail

fixture="$(mktemp -d)"
cleanup() {
    local result="$1"
    if [[ $result -ne 0 && -f "$fixture/sshd.log" ]]; then
        cat "$fixture/sshd.log" >&2
    fi
    ssh -F /dev/null -S "$fixture/control" -O exit localhost 2>/dev/null || true
    if [[ -f "$fixture/sshd.pid" ]]; then
        sudo kill "$(cat "$fixture/sshd.pid")" 2>/dev/null || true
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
Subsystem sftp internal-sftp
CONFIG

sudo install -d -m 0755 /run/sshd
touch "$fixture/sshd.log"
sudo /usr/sbin/sshd -f "$fixture/sshd_config" -E "$fixture/sshd.log"
ssh -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 \
    -i "$fixture/client" -M -S "$fixture/control" -fN -p "$port" "$(id -un)@127.0.0.1"
WORKBENCH_TEST_SFTP_SOCKET="$fixture/control" WORKBENCH_TEST_SFTP_DIRECTORY="$fixture/files" "$@"
