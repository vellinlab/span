#!/usr/bin/env bash
set -euo pipefail

test_home="$(mktemp -d)"
app_pid=
xvfb_pid=
probe_pid=
cleanup() {
    if [[ $1 != 0 && -f "$test_home/app.log" ]]; then
        cat "$test_home/app.log" >&2
        xwininfo -root -tree >&2 || true
    fi
    for pid in "$probe_pid" "$app_pid" "$xvfb_pid"; do
        if [[ -n "$pid" ]]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
    rm -rf -- "$test_home"
}
trap 'cleanup "$?"' EXIT

export HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" GDK_BACKEND=x11 NO_AT_BRIDGE=1
cat > "$HOME/.bash_profile" <<'PROFILE'
printf '%s\n' "$BASHPID" >> "$HOME/bash-ready"
PS1='\[\e[38;5;79m\]\u@local\[\e[0m\]:\w\$ '
PROFILE

if [[ -n ${WORKBENCH_PREVIEW:-} ]]; then
    install -Dm0755 packaging/test-agent.py "$HOME/bin/codex"
    export PATH="$HOME/bin:$PATH"
    convert -size 340x98 xc:'#233045' -fill '#86b4ff' \
        -draw 'roundrectangle 24,58 85,76 3,3 roundrectangle 102,47 163,76 3,3 roundrectangle 180,34 241,76 3,3 roundrectangle 258,20 319,76 3,3' \
        "$HOME/test-output.png"
fi

wait_until() {
    local description="$1"
    shift
    for _ in {1..100}; do
        if "$@"; then
            return
        fi
        sleep 0.1
    done
    printf 'Unable to verify %s.\n' "$description" >&2
    exit 1
}

Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp -noreset 3>"$HOME/display" &
xvfb_pid=$!
wait_until "the Xvfb display" test -s "$HOME/display"
export DISPLAY=":$(cat "$HOME/display")"

"$1" >"$HOME/app.log" 2>&1 &
app_pid=$!
window_exists() {
    kill -0 "$app_pid" 2>/dev/null &&
        xwininfo -root -tree | grep -F '"SSH Workbench"' >/dev/null
}
wait_until "the GTK3 window" window_exists
wait_until "the local Bash PTY" test -s "$HOME/bash-ready"
if grep -q 'Failed to load Workbench theme' "$HOME/app.log"; then
    exit 1
fi
printf '%s\n' 'GTK3 window opened on virtual X11 and the local Bash PTY started.'
awk '/^VmRSS:/ { print "Application RSS with one Bash tab (Xvfb): " $2 " KiB" }' "/proc/$app_pid/status"
awk '/^Pss:/ { print "Application PSS with one Bash tab (Xvfb): " $2 " KiB" }' "/proc/$app_pid/smaps_rollup"

if [[ $# -eq 2 ]]; then
    LD_LIBRARY_PATH=/usr/lib64/ssh-workbench "$2"
fi

if [[ -n ${WORKBENCH_PREVIEW:-} ]]; then
    window="$(xdotool search --onlyvisible --name '^SSH Workbench$' | head -n 1)"
    xdotool windowfocus --sync "$window"
    first_bash="$(head -n1 "$HOME/bash-ready")"

    xdotool key --clearmodifiers ctrl+shift+t
    second_bash_started() {
        [[ $(wc -l < "$HOME/bash-ready") -eq 2 ]]
    }
    wait_until "a second Bash tab" second_bash_started

    xdotool key --clearmodifiers ctrl+shift+n
    dialog_open() {
        xdotool search --onlyvisible --name "^$1$" >/dev/null
    }
    wait_until "the Add Host dialog" dialog_open '添加主机'
    dialog="$(xdotool search --onlyvisible --name '^添加主机$' | head -n1)"
    xdotool windowfocus --sync "$dialog"
    xdotool type --clearmodifiers 'ci-host'
    xdotool key --clearmodifiers shift+Tab
    xdotool type --clearmodifiers 'CI Host'
    xdotool key --clearmodifiers Return
    profile="$XDG_CONFIG_HOME/ssh-workbench/hosts.ini"
    wait_until "the saved SSH target" grep -qs '^target=ci-host$' "$profile"
    grep -qx 'name=CI Host' "$profile"
    grep -qx 'trusted-x11=false' "$profile"

    xdotool windowfocus --sync "$window"
    xdotool mousemove 1250 770
    mkdir "$HOME/Documents" "$HOME/Projects"
    printf 'Workspace notes\n' > "$HOME/notes.txt"
    xdotool key --clearmodifiers ctrl+shift+f
    sleep 0.5
    import -window "$window" "$WORKBENCH_PREVIEW"
    xdotool key --clearmodifiers ctrl+shift+f
    xdotool key --clearmodifiers ctrl+shift+w
    xdotool type --clearmodifiers 'printf "%s\\n" "$BASHPID" > "$HOME/current-bash"'
    xdotool key --clearmodifiers Return
    wait_until "returning to the first Bash tab" grep -qsx "$first_bash" "$HOME/current-bash"

    xdotool key --clearmodifiers ctrl+shift+a
    sleep 0.2
    xdotool key --clearmodifiers Return
    wait_until "the Codex App Server handshake" test -f "$HOME/agent-ready"
    sleep 0.25
    xdotool type --clearmodifiers 'Show the deployment check'
    xdotool key --clearmodifiers ctrl+Return
    wait_until "the structured Agent reply" test -f "$HOME/agent-replied"
    grep -qx 'Show the deployment check' "$HOME/agent-prompt"
    sleep 0.35
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent.png"
    xdotool key --clearmodifiers ctrl+shift+a
    printf '%s\n' 'Codex session opened, sent a prompt, and received a structured reply.'

    # Check the real OpenSSH client version banner against an isolated loopback listener.
    python3 - "$HOME" <<'PY' &
import socket
import sys
from pathlib import Path

home = Path(sys.argv[1])
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    (home / "ssh-port").write_text(str(listener.getsockname()[1]))
    listener.settimeout(15)
    conn, _ = listener.accept()
    with conn:
        conn.settimeout(5)
        (home / "ssh-banner").write_bytes(conn.makefile("rb").readline())
PY
    probe_pid=$!
    wait_until "the local SSH probe" test -s "$HOME/ssh-port"

    xdotool key --clearmodifiers ctrl+shift+o
    wait_until "the Quick Connect dialog" dialog_open '快速连接'
    dialog="$(xdotool search --onlyvisible --name '^快速连接$' | head -n1)"
    xdotool windowfocus --sync "$dialog"
    xdotool type --clearmodifiers "ssh://127.0.0.1:$(cat "$HOME/ssh-port")"
    xdotool key --clearmodifiers Return
    wait_until "the system OpenSSH banner" grep -qs '^SSH-2.0-OpenSSH_' "$HOME/ssh-banner"
    printf '%s\n' 'Tab creation/closing, host creation/persistence and system OpenSSH all passed.'
fi
