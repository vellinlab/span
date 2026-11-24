#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} != desktop ]]; then
    dnf -y install epel-release rpm-build
    rpmbuild -bb --define '_topdir /tmp/span-preview-rpmbuild' \
        --define 'preview_runtime /artifacts/linux' --define 'dist .el8' \
        --define '_binary_payload w6.gzdio' prototype/test/span-web-preview.spec
    dnf -y install /artifacts/span-0.1.0-1.el8.x86_64.rpm /tmp/span-preview-rpmbuild/RPMS/x86_64/span-web-preview-*.rpm \
        curl nss alsa-lib cups-libs mesa-libgbm libXScrnSaver libXtst libxkbcommon \
        python39 python39-pip python3-pyatspi xorg-x11-server-Xvfb xdotool \
        dbus-daemon openbox openssh-server openssl google-noto-sans-cjk-ttc-fonts ImageMagick
    python3.9 -m pip install --disable-pip-version-check python-xlib==0.33
    getconf GNU_LIBC_VERSION
    test "$(getconf GNU_LIBC_VERSION)" = 'glibc 2.28'
    missing="$(ldd /artifacts/linux/span-preview | awk '/not found/')"
    if [[ -n "$missing" ]]; then printf '%s\n' "$missing"; exit 1; fi
    exec dbus-run-session -- bash "$0" desktop
fi

fixture="$(mktemp -d)"
trap 'jobs -p | xargs -r kill; rm -rf -- "$fixture"' EXIT
Xvfb -displayfd 3 -screen 0 1440x960x24 -nolisten tcp 3>"$fixture/display" &
for _ in {1..50}; do [[ -s "$fixture/display" ]] && break; sleep 0.1; done
export DISPLAY=":$(cat "$fixture/display")"
openbox --sm-disable >"$fixture/wm.log" 2>&1 &
for _ in {1..50}; do wmctrl_state="$(xdotool getwindowfocus 2>/dev/null || true)"; [[ -n "$wmctrl_state" ]] && break; sleep 0.1; done

test "$(stat -c '%U:%G:%a' /usr/libexec/span-web-preview/chrome-sandbox)" = root:root:4755
test_password="$(openssl rand -hex 32)"
useradd --create-home --password "$(openssl passwd -6 "$test_password")" span-preview-ci
unset test_password
runuser -u span-preview-ci -- env -u SPAN_TEST_SSH_ALIAS SPAN_TEST_SANDBOX=1 \
    dbus-run-session -- /artifacts/node prototype/test/smoke.mjs /usr/bin/span-web-preview
cp /tmp/span-preview-rpmbuild/RPMS/x86_64/span-web-preview-*.rpm /artifacts/

chmod 0711 "$fixture"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/host-key"
ssh-keygen -q -t ed25519 -N '' -f "$fixture/client-key"
install -d -m 0700 /root/.ssh
printf '[127.0.0.1]:24222 %s\n' "$(cut -d ' ' -f 1,2 "$fixture/host-key.pub")" > "$fixture/known_hosts"
cat > /root/.ssh/config <<CONFIG
Host span-ci-ssh
    HostName 127.0.0.1
    Port 24222
    User span-preview-ci
    IdentityFile $fixture/client-key
    UserKnownHostsFile $fixture/known_hosts
    IdentitiesOnly yes
    StrictHostKeyChecking yes
CONFIG
cat > "$fixture/remote-shell" <<'SCRIPT'
#!/bin/bash
if [[ -n ${SSH_ORIGINAL_COMMAND:-} ]]; then
    exec /bin/bash -c "$SSH_ORIGINAL_COMMAND"
fi
printf 'span_ssh_connected\n'
exec /bin/bash --noprofile --norc -i
SCRIPT
chmod +x "$fixture/remote-shell"
cat > "$fixture/sshd_config" <<CONFIG
ListenAddress 127.0.0.1:24222
HostKey $fixture/host-key
AuthorizedKeysFile $fixture/client-key.pub
StrictModes no
PermitRootLogin no
AllowUsers span-preview-ci
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
ForceCommand $fixture/remote-shell
CONFIG
install -d -m 0755 /run/sshd
/usr/sbin/sshd -D -e -f "$fixture/sshd_config" &
for _ in {1..30}; do
    if ssh -n -o BatchMode=yes span-ci-ssh 2>/dev/null | grep -q span_ssh_connected; then break; fi
    sleep 0.2
done

export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 SPAN_TEST_SSH_ALIAS=span-ci-ssh
pressure_cpu="$(python3.9 -c 'import os; print(min(os.sched_getaffinity(0)))')"
taskset -c "$pressure_cpu" /artifacts/node prototype/test/terminal-pressure.mjs /artifacts/linux/resources/app/bin/span-workbench-core \
    /artifacts/span-workbench-pty-baseline | tee /artifacts/terminal-pressure.json
/artifacts/node prototype/test/smoke.mjs /artifacts/linux/span-preview /artifacts/el8-workbench.png
/artifacts/node prototype/test/catalog.mjs /artifacts/linux/span-preview /artifacts/el8-catalog.png
SPAN_TEST_SSH_ALIAS= /artifacts/node prototype/test/smoke.mjs /artifacts/linux/span-preview /artifacts/el8-workbench-local.png webgl
taskset -c "$pressure_cpu" /artifacts/node prototype/test/covered-transcript.mjs \
    /artifacts/linux/span-preview /artifacts/covered-baseline/span-preview | tee /artifacts/covered-transcript.json
tar -czf /artifacts/span-web-el8-x86_64.tar.gz -C /artifacts linux

widget_socket="$fixture/widgets.sock"
/usr/libexec/platform-python packaging/test-widget.py --serve "$widget_socket" &
for _ in {1..50}; do [[ -S "$widget_socket" ]] && break; sleep 0.1; done
result=0
python3.9 prototype/test/benchmark.py "$widget_socket" /artifacts/benchmark.json || result=$?
python3.9 prototype/test/benchmark.py --catalog /artifacts/catalog-benchmark.json || result=$?
bash prototype/test/backend.sh "$fixture" || result=$?
exit "$result"
