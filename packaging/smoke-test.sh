#!/usr/bin/env bash
set -euo pipefail

test_home="$(mktemp -d)"
app_pid=
xvfb_pid=
cleanup() {
    for pid in "$app_pid" "$xvfb_pid"; do
        if [[ -n "$pid" ]]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
    rm -rf -- "$test_home"
}
trap cleanup EXIT

export HOME="$test_home" GDK_BACKEND=x11 NO_AT_BRIDGE=1
cat > "$HOME/.bash_profile" <<'PROFILE'
printf '%s\n' 'Bash started under VTE' > "$HOME/bash-ready"
PROFILE

Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp 3>"$HOME/display" &
xvfb_pid=$!
for _ in {1..50}; do
    kill -0 "$xvfb_pid"
    if [[ -s "$HOME/display" ]]; then
        break
    fi
    sleep 0.1
done
export DISPLAY=":$(cat "$HOME/display")"

"$1" &
app_pid=$!
for _ in {1..100}; do
    kill -0 "$app_pid"
    if [[ -s "$HOME/bash-ready" ]] && xwininfo -root -tree | grep -F '"SSH Workbench"' >/dev/null; then
        printf '%s\n' 'GTK3 window opened on virtual X11 and the local Bash PTY started.'
        if [[ $# -eq 2 ]]; then
            LD_LIBRARY_PATH=/usr/lib64/ssh-workbench "$2"
        fi
        exit 0
    fi
    sleep 0.1
done

printf '%s\n' 'Unable to verify the GTK3 window and local Bash PTY.' >&2
exit 1
