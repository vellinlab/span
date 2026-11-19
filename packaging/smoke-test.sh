#!/usr/bin/env bash
set -euo pipefail

test_home="$(mktemp -d)"
app_pid=
xvfb_pid=
probe_pid=
cleanup() {
    if [[ $1 != 0 && -f "$test_home/app.log" ]]; then
        cat "$test_home/app.log" >&2
        if [[ -f "$test_home/agent-request" ]]; then
            cat "$test_home/agent-request" >&2
        fi
        xwininfo -root -tree >&2 || true
        if [[ -n ${window:-} && -n ${WORKBENCH_PREVIEW:-} ]]; then
            import -window root "$(dirname "$WORKBENCH_PREVIEW")/test-failure.png" || true
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

export HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" XDG_DATA_HOME="$test_home/.local/share" GDK_BACKEND=x11 NO_AT_BRIDGE=1
export TMPDIR="$test_home/tmp"
mkdir "$TMPDIR"
cat > "$HOME/.bash_profile" <<'PROFILE'
printf '%s\n' "$BASHPID" >> "$HOME/bash-ready"
PS1='\[\e[38;5;79m\]\u@local\[\e[0m\]:\w\$ '
PROFILE

if [[ -n ${WORKBENCH_PREVIEW:-} ]]; then
    unset NO_AT_BRIDGE
    export GTK_IM_MODULE=gtk-im-context-simple
    profile="$XDG_CONFIG_HOME/ssh-workbench/hosts.ini"
    mkdir -p "$(dirname "$profile")"
    cat > "$profile" <<'HOSTS'
[Workbench]
version=1

[Host 1]
name=Legacy CI host
target=legacy-ci-host
trusted-x11=true
HOSTS
    install -Dm0755 packaging/test-agent.py "$HOME/bin/codex"
    mkdir -p "$XDG_DATA_HOME/applications"
    cat > "$HOME/bin/span-test-open-link" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$1" > "$HOME/span-opened-link"
SCRIPT
    chmod +x "$HOME/bin/span-test-open-link"
    cat > "$XDG_DATA_HOME/applications/span-test-open-link.desktop" <<DESKTOP
[Desktop Entry]
Name=Span Link Test
Type=Application
Exec=$HOME/bin/span-test-open-link %u
MimeType=x-scheme-handler/https;
DESKTOP
    printf '%s\n' '[Default Applications]' 'x-scheme-handler/https=span-test-open-link.desktop;' > "$XDG_CONFIG_HOME/mimeapps.list"
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

Xvfb -displayfd 3 -screen 0 1600x980x24 -nolisten tcp -noreset 3>"$HOME/display" &
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
    LD_LIBRARY_PATH=/usr/lib64/span "$2"
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
    attachment_chooser_closed() {
        ! dialog_open '添加附件'
    }
    add_attachment() {
        local file="$1" chooser
        widget click '附件'
        wait_until "the attachment chooser" dialog_open '添加附件'
        chooser="$(xdotool search --onlyvisible --name '^添加附件$' | head -n1)"
        xdotool windowfocus --sync "$chooser"
        widget mouse "${file##*/}"
        widget mouse '添加'
        wait_until "confirming the selected file" attachment_chooser_closed
        widget contains "${file##*/}"
        xdotool windowfocus --sync "$window"
        widget mouse '输入消息，或添加附件'
    }
    paste_image() {
        xclip -in -selection clipboard -target image/png "$HOME/test-output.png"
        xdotool key --clearmodifiers ctrl+v
        widget contains '剪贴板图片.png'
    }
    wait_until "the Add Host dialog" dialog_open '添加主机'
    dialog="$(xdotool search --onlyvisible --name '^添加主机$' | head -n1)"
    xdotool windowfocus --sync "$dialog"
    xdotool type --clearmodifiers 'ci-host'
    xdotool key --clearmodifiers shift+Tab
    xdotool type --clearmodifiers 'CI Host'
    xdotool key --clearmodifiers Return
    wait_until "the saved SSH target" grep -qs '^target=ci-host$' "$profile"
    grep -qx 'name=Legacy CI host' "$profile"
    grep -qx 'target=legacy-ci-host' "$profile"
    grep -qx 'trusted-x11=true' "$profile"
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
    widget not-state 'Fast 模式' sensitive
    widget mouse '选择模型'
    widget contains 'GPT Vision'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-model-picker.png"
    widget mouse 'GPT Vision'
    read -r _ _ effort_width _ <<< "$(widget bounds '思考强度')"
    [[ $effort_width -lt 112 ]]
    widget mouse '思考强度'
    widget contains '默认'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-effort-picker.png"
    widget mouse '高'
    widget state 'Fast 模式' sensitive
    widget not-state 'Fast 模式' checked
    widget mouse 'Fast 模式'
    widget state 'Fast 模式' checked
    widget mouse '消息输入框'
    widget state '消息输入框' focused
    add_attachment "$HOME/test-output.png"
    paste_image
    printf '%s' 'Show the deployment check' | xclip -in -selection clipboard
    xdotool key --clearmodifiers ctrl+v
    widget contains 'Show the deployment check'
    # Commit a composed character with Return before sending the message.
    xdotool key --clearmodifiers Shift+Return ctrl+shift+u 4 f 6 0 Return
    prompt=$'Show the deployment check\n你'
    widget contains "$prompt"
    [[ ! -e "$HOME/agent-request" ]]
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-compose.png"
    xdotool key --clearmodifiers Return
    wait_until "the structured Agent reply" test -f "$HOME/agent-replied"
    [[ $(cat "$HOME/agent-prompt") == "$prompt" ]]
    printf '%s\n' 'Enter commits input composition, then sends. Shift+Enter inserts a newline.'
    widget contains '等待你的回复'
    [[ $(widget count '复制 Markdown') == 0 && $(widget count '复制富文本') == 0 ]]
    widget not-contains 'fixture duplicate prompt sentinel'
    sleep 0.15
    xdotool mousemove --window "$window" 355 390 click --repeat 16 4
    widget mouse '进行中 · 修改文件 · checks.txt…'
    widget contains 'Checking the build before publishing.'
    widget not-contains '**Checking the build'
    widget not-contains 'fixture raw reasoning sentinel'
    widget mouse '读取文件 · checks.txt'
    widget expanded-contains '读取文件 · checks.txt' 'integration test passed'
    widget mouse '修改文件 · checks.txt…'
    widget expanded-contains '修改文件 · checks.txt…' '+passed'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-activity.png"
    widget mouse '进行中 · 修改文件 · checks.txt…'
    xdotool mousemove --window "$window" 355 390 click --repeat 16 5
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
    read -r cell_x cell_y _ cell_height < <(widget bounds 'Check')
    read -r next_x next_y next_width next_height < <(widget bounds 'Result')
    xdotool mousemove "$((cell_x + 5))" "$((cell_y + cell_height / 2))" mousedown 1 \
        sleep 0.15 mousemove "$((next_x + next_width / 2))" "$((next_y + next_height / 2))" sleep 0.15 mouseup 1
    xdotool key --clearmodifiers ctrl+c
    selected_text="$(xclip -out -selection clipboard)"
    if [[ $selected_text != $'Check\tResult' ]]; then
        printf 'Unexpected text after dragging across cells: %q\n' "$selected_text" >&2
        exit 1
    fi
    before_scroll="$(widget scroll-value '对话记录')"
    xdotool mousemove "$((cell_x + 5))" "$((cell_y + cell_height / 2))" mousedown 1 click 5
    after_scroll="$(widget scroll-value '对话记录')"
    xdotool mouseup 1
    ((after_scroll > before_scroll))
    xdotool mousemove --window "$window" 900 360 click 4
    printf '%s\n' 'Direct text selection copies across table cells and the conversation scrolls during a drag.'
    widget click '复制 CSV'
    xclip -out -selection clipboard | tr -d '\r' > "$HOME/table.csv"
    grep -qx 'Integration,12 passed' "$HOME/table.csv"
    widget click '复制 HTML'
    xclip -out -selection clipboard -target text/html > "$HOME/table.html"
    grep -q '<td>12 passed</td>' "$HOME/table.html"
    widget click '复制 Markdown'
    copied_turn="$(xclip -out -selection clipboard)"
    [[ $copied_turn == *'| Integration | 12 passed |'* && $copied_turn == *'Environment confirmed.'* ]]
    [[ $(widget count '复制 Markdown') == 1 && $(widget count '复制富文本') == 1 ]]
    widget click '复制代码'
    xclip -out -selection clipboard | grep -qx 'target=staging'
    widget click '保存 PNG'
    wait_until "the Save PNG dialog" dialog_open '保存文件'
    save_dialog="$(xdotool search --onlyvisible --name '^保存文件$' | head -n1)"
    xdotool windowfocus --sync "$save_dialog"
    xdotool key --clearmodifiers Escape
    xdotool windowfocus --sync "$window"

    xdotool key --clearmodifiers ctrl+shift+h
    wait_until "the host-scoped session sidebar" test -f "$HOME/agent-catalog"
    widget contains 'Deployment rollout'
    xdotool windowsize --sync "$window" 1580 950
    xdotool key --clearmodifiers ctrl+shift+f
    sleep 0.35
    xdotool mousemove --window "$window" 355 390 click --repeat 16 4
    sleep 0.2
    widget contains 'Deployment checklist'
    widget mouse 'Build documentation'
    wait_until "opening the clicked Markdown link" grep -qFx 'https://example.invalid/span/docs?from=agent&view=build' "$HOME/span-opened-link"
    read -r wide_x _ < <(widget bounds '输入消息，或添加附件')
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-workspace.png"
    xdotool windowsize --sync "$window" 1170 940
    sleep 0.2
    read -r narrow_x _ < <(widget bounds '输入消息，或添加附件')
    ((wide_x > narrow_x + 32))
    xdotool key --clearmodifiers ctrl+shift+f
    xdotool windowsize --sync "$window" 1250 940
    printf '%s\n' 'The centered composer adapts to both wide and narrow split layouts.'

    widget mouse 'Fast 模式'
    widget not-state 'Fast 模式' checked
    widget mouse '输入消息，或添加附件'
    xdotool type --clearmodifiers 'Check the comparison layout'
    widget click '发送'
    widget contains 'Preparing the comparison table.'
    widget not-contains '**Preparing the comparison table.**'
    widget contains '正在生成回复'
    widget contains 'Esc 中断'
    widget contains '已运行 0:'
    sleep 1.2
    widget not-contains '已运行 0:00'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-task-status.png"
    widget mouse '输入消息，或添加附件'
    xdotool type --clearmodifiers 'Focus on X11'
    widget bounds '追加消息' >/dev/null
    widget bounds '中断推理' >/dev/null
    xdotool key --clearmodifiers Return
    widget contains 'Fixture steer rejected'
    widget contains 'Focus on X11'
    xdotool key --clearmodifiers Return
    wait_until "the follow-up on the original turn" test -f "$HOME/agent-steered"
    widget contains '已追加'
    widget not-contains 'fixture duplicate steer sentinel'
    printf '%s\n' 'Active-turn messages preserve the draft on rejection and retry on the same turn.'
    read -r stop_x stop_y stop_width stop_height < <(widget bounds '中断推理')
    ((stop_width == stop_height))
    xdotool key --clearmodifiers Escape
    read -r pause_x pause_y _ < <(widget bounds '继续推理')
    ((stop_x == pause_x && stop_y == pause_y))
    widget contains '已中断'
    widget contains 'Preparing the comparison table.'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-paused.png"
    widget mouse '输入消息，或添加附件'
    xdotool type --clearmodifiers 'Another question'
    widget bounds '发送' >/dev/null
    xdotool key --clearmodifiers ctrl+a BackSpace
    widget click '继续推理'
    widget contains 'AgentScope'
    widget bounds '发送' >/dev/null

    table_geometry() {
        local row_y row_height actions_y
        read -r _ row_y _ row_height < <(widget bounds 'AgentScope')
        read -r _ actions_y _ < <(widget bounds '复制 HTML')
        if ((actions_y < row_y + row_height || actions_y > row_y + row_height + 40)); then
            printf 'Unexpected gap after table: row bottom %s, copy action top %s\n' "$((row_y + row_height))" "$actions_y" >&2
            return 1
        fi
        printf '%s\n' "$row_height"
    }
    wide_row="$(table_geometry)"
    xdotool windowsize --sync "$window" 990 940
    sleep 0.25
    xdotool mousemove --window "$window" 355 390 click --repeat 12 5
    narrow_row="$(table_geometry)"
    ((narrow_row > wide_row))
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-table.png"
    xdotool windowsize --sync "$window" 1250 940
    printf '%s\n' 'The composer applies both fast and standard speeds, reports elapsed task time, interrupts with Esc, and continues in place.'

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
    read -r _ _ dot_width _ <<< "$(widget bounds '就绪')"
    [[ $dot_width -le 10 ]]
    widget click '加载更早的对话'
    wait_until "loading an older page" test -f "$HOME/agent-older-page"
    widget contains 'Earlier deployment notes'
    widget mouse '已完成 · 3 项活动'
    widget contains 'Checked the saved deployment plan.'
    widget not-contains 'fixture raw reasoning sentinel'
    widget mouse '运行命令 · printf archived'
    widget expanded-contains '运行命令 · printf archived' 'Historical command output'
    widget mouse '运行命令 · printf archived'
    widget mouse '修改文件 · checks.txt'
    widget expanded-contains '修改文件 · checks.txt' '+passed'
    widget mouse '修改文件 · checks.txt'
    widget mouse '本轮变更 · 查看 diff'
    widget expanded-contains '本轮变更 · 查看 diff' '+passed'

    widget click '刷新'
    widget contains '点击会话继续'
    xdotool key --clearmodifiers ctrl+shift+f
    widget contains 'agent-older-page'
    printf 'Workspace preview fixture\n' > "$HOME/000-switch-fixture.txt"
    xdotool key --clearmodifiers ctrl+shift+t
    widget contains 'Release checklist'
    widget contains '000-switch-fixture.txt'
    catalog_requests="$(wc -l < "$HOME/agent-catalog-requests")"
    xdotool key --clearmodifiers ctrl+Page_Up
    widget contains 'Deployment rollout'
    widget contains 'agent-older-page'
    widget not-contains 'Release checklist'
    widget not-contains '000-switch-fixture.txt'
    xdotool key --clearmodifiers ctrl+Page_Down
    widget contains 'Release checklist'
    widget contains '000-switch-fixture.txt'
    [[ $(wc -l < "$HOME/agent-catalog-requests") -eq $catalog_requests ]]
    xdotool key --clearmodifiers ctrl+shift+w
    widget not-contains 'Release checklist'
    widget click '刷新目录'
    widget contains '000-switch-fixture.txt'
    widget mouse '000-switch-fixture.txt'
    widget state '预览' sensitive
    widget click '预览'
    widget contains 'Workspace preview fixture'
    widget state '下载' sensitive
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/files-preview.png"
    widget click '返回目录'
    xdotool key --clearmodifiers ctrl+shift+f
    printf '%s\n' 'Warm tab switches reused their catalogs and directory models. Explicit refresh read the new file.'
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
    widget contains 'SSH 目标'
    widget bounds '信任 X11 转发' >/dev/null
    connect_preview="$(dirname "$WORKBENCH_PREVIEW")/quick-connect.png"
    import -window "$dialog" "$connect_preview"
    [[ $(convert "$connect_preview" -crop 1x1+15+80 -colorspace Gray -format '%[fx:mean < 0.35]' info:) == 1 ]]
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
        widget contains 'Check the rollout from my other device.'
        widget contains 'The shared rollout is healthy.'
        ssh_socket="$(find "$TMPDIR" -type s -path '*/swb-*/ssh' -print -quit)"
        test -S "$ssh_socket"
        ssh -F /dev/null -S "$ssh_socket" -O exit localhost
        widget click '重新连接'
        resumed_twice() { [[ $(wc -l < "$WORKBENCH_SSH_FIXTURE/agent-resumed") -eq 2 ]]; }
        wait_until "automatic restoration on SSH reconnect" resumed_twice
        widget contains 'Latest deployment notes'
        add_attachment "$HOME/notes.txt"
        paste_image
        xdotool type --clearmodifiers 'Read the remote attachment'
        xdotool key --clearmodifiers ctrl+Return
        wait_until "remote file attachment bytes, permissions, and path" test -f "$WORKBENCH_SSH_FIXTURE/agent-uploaded"
        printf '%s\n' 'Span used the remote shared Codex socket, received external turn events and reopened the same session after SSH reconnect.'
        printf '%s\n' 'Picker files, model and effort overrides, token and account usage, and remote attachment uploads passed.'
    fi
fi
