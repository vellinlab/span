#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} != desktop ]]; then
    dnf -y install epel-release
    dnf -y install /artifacts/span-0.1.0-1.el8.x86_64.rpm \
        curl nss alsa-lib cups-libs mesa-libgbm libXScrnSaver libXtst libxkbcommon \
        python39 python39-pip python3-pyatspi xorg-x11-server-Xvfb xdotool \
        dbus-daemon openbox google-noto-sans-cjk-ttc-fonts
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

export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
/artifacts/node prototype/test/smoke.mjs /artifacts/linux/span-preview /artifacts/el8-workbench.png
tar -czf /artifacts/span-web-el8-x86_64.tar.gz -C /artifacts linux

widget_socket="$fixture/widgets.sock"
/usr/libexec/platform-python packaging/test-widget.py --serve "$widget_socket" &
for _ in {1..50}; do [[ -S "$widget_socket" ]] && break; sleep 0.1; done
bash prototype/test/backend.sh "$fixture"
python3.9 prototype/test/benchmark.py "$widget_socket" /artifacts/benchmark.json
