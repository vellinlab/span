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
        if [[ -n ${window:-} && -n ${WORKBENCH_PREVIEW:-} ]]; then
            import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/test-failure.png" || true
        fi
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
export TMPDIR="$test_home/tmp"
mkdir "$TMPDIR"
cat > "$HOME/.bash_profile" <<'PROFILE'
printf '%s\n' "$BASHPID" >> "$HOME/bash-ready"
PS1='\[\e[38;5;79m\]\u@local\[\e[0m\]:\w\$ '
PROFILE

if [[ -n ${WORKBENCH_PREVIEW:-} ]]; then
    unset NO_AT_BRIDGE
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

Xvfb -displayfd 3 -screen 0 1360x980x24 -nolisten tcp -noreset 3>"$HOME/display" &
xvfb_pid=$!
wait_until "the Xvfb display" test -s "$HOME/display"
export DISPLAY=":$(cat "$HOME/display")"

"$1" >"$HOME/app.log" 2>&1 &
app_pid=$!
window_exists() {
    kill -0 "$app_pid" 2>/dev/null &&
        xwininfo -root -tree | grep -F '"Span"' >/dev/null
}
wait_until "the GTK3 window" window_exists
wait_until "the local Bash PTY" test -s "$HOME/bash-ready"
window="$(xwininfo -root -tree | awk '/"Span"/ && !found { print $1; found=1 }')"
xprop -id "$window" _NET_WM_ICON | grep -F '_NET_WM_ICON(CARDINAL) =' >/dev/null
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
    widget() { /usr/bin/python3 packaging/test-widget.py "$@"; }
    add_attachment() {
        local file="$1" chooser
        widget click '附件'
        wait_until "the attachment chooser" dialog_open '添加附件'
        chooser="$(xdotool search --onlyvisible --name '^添加附件$' | head -n1)"
        xdotool windowfocus --sync "$chooser"
        xdotool key --clearmodifiers ctrl+l
        xdotool type --clearmodifiers "$file"
        xdotool key --clearmodifiers Return
        widget contains "${file##*/}"
        xdotool windowfocus --sync "$window"
        widget mouse '输入消息，或添加附件'
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
    xdotool windowsize "$window" 1250 940
    sleep 0.2
    xdotool key --clearmodifiers Return
    wait_until "the Codex App Server handshake" test -f "$HOME/agent-ready"
    wait_until "the second model catalog page" test -f "$HOME/agent-models"
    sleep 0.25
    widget combo-next 0
    widget combo-next 1
    add_attachment "$HOME/test-output.png"
    xdotool type --clearmodifiers 'Show the deployment check'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-compose.png"
    xdotool key --clearmodifiers ctrl+Return
    wait_until "the structured Agent reply" test -f "$HOME/agent-replied"
    grep -qx 'Show the deployment check' "$HOME/agent-prompt"
    widget contains 'Which deployment environment?'
    xdotool mousemove --window "$window" 900 710 click --repeat 8 5
    sleep 0.25
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-question.png"
    widget fill-card 'Which deployment environment?' Staging
    widget click '提交答案'
    wait_until "the structured answer" test -f "$HOME/agent-answered"
    widget click '用量 · 13%'
    widget contains '会话累计 · 12,800 tokens'
    widget contains '5 小时 · 已用 17%'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-usage.png"
    xdotool key --clearmodifiers Escape
    widget mouse '本轮变更 · 查看 diff'
    widget expanded-contains '本轮变更 · 查看 diff' '+passed'
    widget mouse '本轮变更 · 查看 diff'

    xdotool mousemove --window "$window" 900 360 click --repeat 8 4
    sleep 0.25
    widget click '复制 CSV'
    xclip -out -selection clipboard | tr -d '\r' > "$HOME/table.csv"
    grep -qx 'Integration,12 passed' "$HOME/table.csv"
    widget click '复制 HTML'
    xclip -out -selection clipboard -target text/html > "$HOME/table.html"
    grep -q '<td>12 passed</td>' "$HOME/table.html"
    widget click '复制 Markdown'
    xclip -out -selection clipboard | grep -qF '| Integration | 12 passed |'
    widget click '保存 PNG'
    wait_until "the Save PNG dialog" dialog_open '保存文件'
    save_dialog="$(xdotool search --onlyvisible --name '^保存文件$' | head -n1)"
    xdotool windowfocus --sync "$save_dialog"
    xdotool key --clearmodifiers Escape
    xdotool windowfocus --sync "$window"

    xdotool key --clearmodifiers ctrl+shift+j
    sleep 0.25
    xdotool type --clearmodifiers 'printf "%s\n" "$BASHPID" > "$HOME/drawer-bash"'
    xdotool key --clearmodifiers Return
    wait_until "the original Bash in the Agent drawer" grep -qsx "$first_bash" "$HOME/drawer-bash"
    sleep 0.35
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent.png"
    xdotool key --clearmodifiers ctrl+shift+j
    xdotool key --clearmodifiers ctrl+shift+h
    wait_until "the host-scoped session list" test -f "$HOME/agent-catalog"
    widget contains 'Deployment rollout'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-catalog.png"
    xdotool type --clearmodifiers 'Deployment'
    wait_until "the server-side session search" test -f "$HOME/agent-searched"
    sleep 0.25
    xdotool key --clearmodifiers Return
    wait_until "resuming a saved Codex session" test -f "$HOME/agent-resumed"
    widget click '加载更早的对话'
    wait_until "loading an older page" test -f "$HOME/agent-older-page"
    widget contains 'Earlier deployment notes'
    xdotool key --clearmodifiers ctrl+shift+a
    printf '%s\n' 'The Codex session tested formatted table data, structured questions, diff, drawer, search and paginated history.'

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

    if [[ -n ${WORKBENCH_SSH_FIXTURE:-} ]]; then
        xdotool key --clearmodifiers ctrl+shift+o
        wait_until "the remote fixture Quick Connect dialog" dialog_open '快速连接'
        dialog="$(xdotool search --onlyvisible --name '^快速连接$' | head -n1)"
        xdotool windowfocus --sync "$dialog"
        xdotool type --clearmodifiers "ssh://$WORKBENCH_SSH_USER@127.0.0.1:$WORKBENCH_SSH_PORT"
        xdotool key --clearmodifiers Return
        xdotool windowfocus --sync "$window"
        widget contains 'Are you sure you want to continue connecting'
        xdotool type --clearmodifiers yes
        xdotool key --clearmodifiers Return
        wait_until "the authenticated SSH shell" test -s "$WORKBENCH_SSH_FIXTURE/remote-shells"
        xdotool key --clearmodifiers ctrl+shift+h
        wait_until "the remote session list" test -f "$WORKBENCH_SSH_FIXTURE/agent-catalog"
        xdotool type --clearmodifiers 'Deployment'
        wait_until "search on the remote host" test -f "$WORKBENCH_SSH_FIXTURE/agent-searched"
        sleep 0.25
        xdotool key --clearmodifiers Return
        wait_until "resuming the remote session" grep -qsx stored-deployment "$WORKBENCH_SSH_FIXTURE/agent-resumed"
        widget contains 'Latest deployment notes'
        ssh_socket="$(find "$TMPDIR" -type s -path '*/swb-*/ssh' -print -quit)"
        test -S "$ssh_socket"
        ssh -F /dev/null -S "$ssh_socket" -O exit localhost
        widget click '重新连接'
        resumed_twice() { [[ $(wc -l < "$WORKBENCH_SSH_FIXTURE/agent-resumed") -eq 2 ]]; }
        wait_until "automatic restoration on SSH reconnect" resumed_twice
        widget contains 'Latest deployment notes'
        add_attachment "$HOME/notes.txt"
        xdotool type --clearmodifiers 'Read the remote attachment'
        xdotool key --clearmodifiers ctrl+Return
        wait_until "remote file attachment bytes, permissions, and path" test -f "$WORKBENCH_SSH_FIXTURE/agent-uploaded"
        printf '%s\n' 'A saved remote Codex session was restored after disconnecting and restarting its authenticated SSH tab.'
        printf '%s\n' 'Picker files, model and effort overrides, token and account usage, and remote attachment uploads passed.'
    fi
fi
