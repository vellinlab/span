#!/usr/bin/env bash
set -euo pipefail

test_home="$(mktemp -d)"
app_pid=
xvfb_pid=
probe_pid=
askpass_pid=
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
    for pid in "$askpass_pid" "$probe_pid" "$app_pid" "$xvfb_pid"; do
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

sample_memory() {
    local stage="$1" pid name
    while read -r pid name; do
        if [[ -r "/proc/$pid/smaps_rollup" ]]; then
            awk -v stage="$stage" -v process="$name" -v pid="$pid" '
                /^(Rss|Pss|Pss_Anon|Pss_File|Private_Clean|Private_Dirty):/ {
                    printf "%s%s=%s KiB", fields++ ? ", " : "", substr($1, 1, length($1) - 1), $2
                }
                END { printf " [%s, %s pid=%s]\n", stage, process, pid }
            ' "/proc/$pid/smaps_rollup" 2>/dev/null || true
        fi
    done < <(ps -eo pid=,ppid=,comm= | awk -v root="$app_pid" '
        { parent[$1] = $2; name[$1] = $3 }
        END {
            print root, name[root]
            for (pid in parent)
                for (p = parent[pid]; p > 0; p = parent[p])
                    if (p == root) { print pid, name[pid]; break }
        }
    ')
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
sample_memory "one Bash tab"

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
    timeline_wheel() {
        local x y height
        read -r x y _ height < <(widget bounds '对话记录')
        xdotool mousemove "$((x + 8))" "$((y + height / 2))" click --repeat "$2" "$1"
    }
    attachment_chooser_closed() {
        ! dialog_open '添加附件'
    }
    add_attachment() {
        local file="$1" chooser
        widget click '附件'
        wait_until "the attachment chooser" dialog_open '添加附件'
        chooser="$(xdotool search --onlyvisible --name '^添加附件$' | head -n1)"
        xdotool windowfocus --sync "$chooser"
        SPAN_TEST_DIALOG='添加附件' widget mouse "${file##*/}"
        SPAN_TEST_DIALOG='添加附件' widget mouse '添加'
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
    printf 'Split workspace preview\n' > "$HOME/000-layout.txt"
    cat > "$HOME/000-preview.md" <<'MARKDOWN'
# Preview code proof

```python
span_preview_marker = True
# Keep the full excerpt visible in the composer.
# Quotes may contain several lines.
# The last line must remain readable.
# End of the quotation fixture.
```
MARKDOWN
    cat > "$HOME/000-source.py" <<'PYTHON'
# Native source preview
import os


def load_settings():
    return os.getenv("SPAN_TEST_MODE", "standard")  # preserve spacing
PYTHON
    for line in {1..96}; do
        printf '    setting_%s = os.getenv("SPAN_TEST_SETTING_%s", "initialize the full-width source preview for the scrolling regression test")\n' "$line" "$line"
    done >> "$HOME/000-source.py"
    cat > "$HOME/000-vector.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="58" viewBox="0 0 64 58">
  <rect width="64" height="58" fill="#162234"/>
  <rect fill="white" x="16.25" y="2" width="0.5" height="54"/>
  <circle fill="none" stroke="#8aabf4" stroke-width=".5" cx="43" cy="28" r="15"/>
  <path fill="none" stroke="#a4d8c9" stroke-width=".65" d="M33 33 L39 24 L44 30 L53 21"/>
</svg>
SVG
    xdotool key --clearmodifiers ctrl+shift+f
    sleep 0.5
    read -r sidebar_x sidebar_y sidebar_width sidebar_height < <(widget bounds '工作区侧栏')
    divider_x=$((sidebar_x + sidebar_width + 1))
    divider_y=$((sidebar_y + sidebar_height / 2))
    xdotool mousemove "$divider_x" "$divider_y" mousedown 1 sleep 0.1 \
        mousemove "$((divider_x + 72))" "$divider_y" sleep 0.1 mouseup 1
    read -r _ _ expanded_sidebar _ < <(widget bounds '工作区侧栏')
    ((expanded_sidebar >= sidebar_width + 60))
    xdotool mousemove "$((divider_x + expanded_sidebar - sidebar_width))" "$divider_y" mousedown 1 sleep 0.1 \
        mousemove "$divider_x" "$divider_y" sleep 0.1 mouseup 1
    import -window "$window" "$WORKBENCH_PREVIEW"
    xdotool key --clearmodifiers ctrl+shift+f
    xdotool key --clearmodifiers ctrl+shift+w
    xdotool type --clearmodifiers 'printf "%s\\n" "$BASHPID" > "$HOME/current-bash"'
    xdotool key --clearmodifiers Return
    wait_until "returning to the first Bash tab" grep -qsx "$first_bash" "$HOME/current-bash"

    widget click '切换 Codex 会话／终端'
    xdotool windowsize "$window" 1250 940
    sleep 0.2
    xdotool key --clearmodifiers Return
    wait_until "the Codex App Server handshake" test -f "$HOME/agent-ready"
    wait_until "the second model catalog page" test -f "$HOME/agent-models"
    sleep 0.25
    sample_memory "Codex connected"
    read -r _ bar_y _ bar_h <<< "$(widget bounds '附件')"
    for name in '会话权限' '选择模型' '思考强度' 'Fast 模式' '用量' '发送'; do
        read -r _ control_y _ control_h <<< "$(widget bounds "$name")"
        center_delta=$((2 * (control_y - bar_y) + control_h - bar_h))
        ((center_delta >= -2 && center_delta <= 2))
    done
    widget description '会话权限' '工作区权限'
    widget mouse '会话权限'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-permissions.png"
    widget mouse '完全访问'
    wait_until "confirming Full Access explicitly" dialog_open '会话权限'
    permission_dialog="$(xdotool search --onlyvisible --name '^会话权限$' | head -n1)"
    xdotool windowfocus --sync "$permission_dialog"
    widget click '取消'
    wait_until "closing the permissions confirmation" bash -c '! xdotool search --onlyvisible --name "^会话权限$" >/dev/null'
    xdotool windowfocus --sync "$window"
    widget description '会话权限' '工作区权限'
    widget mouse '会话权限'
    widget mouse '只读'
    widget description '会话权限' '只读'
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
    widget bounds '预览区' >/dev/null
    widget click '原始大小'
    widget click '放大图片'
    widget contains '125%'
    read -r image_x image_y image_width _ <<< "$(widget bounds '预览区')"
    xdotool mousemove "$((image_x + image_width / 2))" "$((image_y + 114))" keydown ctrl click 5 keyup ctrl
    widget contains '100%'
    xdotool keydown ctrl click 4 keyup ctrl
    widget contains '125%'
    widget click '适合宽度'
    widget click '上一个预览'
    widget bounds 'Mermaid 图' >/dev/null
    widget click '关闭预览'
    [[ $(widget count '复制本轮 Markdown') == 0 && $(widget count '复制本轮富文本') == 0 ]]
    widget not-contains 'fixture duplicate prompt sentinel'
    sleep 0.15
    timeline_wheel 4 16
    widget mouse '已完成 · 4 项活动'
    widget contains 'Checking the build before publishing.'
    widget not-contains '**Checking the build'
    widget not-contains 'fixture raw reasoning sentinel'
    widget mouse '读取文件 · checks.txt'
    widget expanded-contains '读取文件 · checks.txt' 'integration test passed'
    widget mouse '修改文件 · checks.txt…'
    widget expanded-contains '修改文件 · checks.txt…' '+passed'
    widget mouse '在网页中查找 · deployment checklist documentation'
    widget expanded-contains '在网页中查找 · deployment checklist documentation' 'example.invalid'
    widget mouse-text 'example.invalid'
    wait_until "opening the activity source" grep -qFx 'https://example.invalid/activity/checklist?from=span&view=doc' "$HOME/span-opened-link"
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-activity.png"
    widget mouse '已完成 · 4 项活动'
    timeline_wheel 5 16
    widget contains 'Which deployment environment?'
    timeline_wheel 5 8
    sleep 0.25
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-question.png"
    widget fill-card 'Which deployment environment?' Staging
    widget click '提交答案'
    wait_until "the structured answer" test -f "$HOME/agent-answered"
    widget contains 'Generated workspace page'
    widget contains 'Deployment preview & status'
    widget not-contains 'fixture script sentinel'
    widget mouse-text '预览里的链接'
    wait_until "opening a web link from the HTML preview" grep -qFx 'https://example.invalid/span/preview?a=1&b=2' "$HOME/span-opened-link"
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/generated-preview.png"
    widget click '关闭预览'
    timeline_wheel 5 10
    widget mouse-text 'the generated page'
    widget contains 'Deployment preview & status'
    widget click '关闭预览'
    printf '%s\n' 'Generated images, diagrams and HTML open in the shared preview pane.'
    widget click '用量 · 13%'
    widget contains '会话累计 · 12,800 tokens'
    widget contains '5 小时 · 已用 17%'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-usage.png"
    xdotool key --clearmodifiers Escape
    widget mouse '本轮变更 · 查看 diff'
    widget expanded-contains '本轮变更 · 查看 diff' '+passed'
    widget mouse '本轮变更 · 查看 diff'

    timeline_wheel 4 8
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
    timeline_wheel 4 1
    printf '%s\n' 'Direct text selection copies across table cells and the conversation scrolls during a drag.'
    widget click '复制 CSV'
    xclip -out -selection clipboard | tr -d '\r' > "$HOME/table.csv"
    grep -qx 'Integration,12 passed' "$HOME/table.csv"
    widget click '复制 HTML'
    xclip -out -selection clipboard -target text/html > "$HOME/table.html"
    grep -q '<td>12 passed</td>' "$HOME/table.html"
    read -r code_x code_y _ code_height < <(widget bounds '复制代码')
    before_scroll="$(widget scroll-value '对话记录')"
    xdotool mousemove "$((code_x - 90))" "$((code_y + code_height + 12))" click 5
    after_scroll="$(widget scroll-value '对话记录')"
    if ((after_scroll <= before_scroll)); then
        printf 'Wheel over the code block did not scroll the conversation (%d to %d).\n' "$before_scroll" "$after_scroll" >&2
        exit 1
    fi
    printf '%s\n' 'The wheel scrolls the conversation over a code block that has reached its edge.'
    widget click '复制代码'
    xclip -out -selection clipboard | grep -qx 'target=staging'
    widget click '保存 PNG'
    wait_until "the Save PNG dialog" dialog_open '保存文件'
    save_dialog="$(xdotool search --onlyvisible --name '^保存文件$' | head -n1)"
    xdotool windowfocus --sync "$save_dialog"
    xdotool key --clearmodifiers Escape
    xdotool windowfocus --sync "$window"
    timeline_wheel 5 16
    widget contains 'Environment confirmed.'
    widget click '复制本轮 Markdown'
    copied_turn="$(xclip -out -selection clipboard)"
    [[ $copied_turn == *'| Integration | 12 passed |'* && $copied_turn == *'Environment confirmed.'* ]]
    [[ $(widget count '复制本轮 Markdown') == 1 && $(widget count '复制本轮富文本') == 1 ]]
    widget click '复制本轮富文本'
    xclip -out -selection clipboard -target text/html > "$HOME/turn.html"
    grep -q 'Environment confirmed.' "$HOME/turn.html"
    printf '%s\n' 'Only completed turns show the two copy icons, and both include all of the turn’s replies.'

    xdotool key --clearmodifiers ctrl+shift+h
    wait_until "the host-scoped session sidebar" test -f "$HOME/agent-catalog"
    widget contains 'Deployment rollout'
    xdotool windowsize --sync "$window" 1580 950
    xdotool key --clearmodifiers ctrl+shift+f
    widget mouse '000-layout.txt'
    widget click '预览'
    widget contains 'Split workspace preview'
    sleep 0.35
    timeline_wheel 4 16
    sleep 0.2
    widget contains 'Deployment checklist'
    widget mouse 'Build documentation'
    wait_until "opening the clicked Markdown link" grep -qFx 'https://example.invalid/span/docs?from=agent&view=build' "$HOME/span-opened-link"
    widget mouse-text '发布说明'
    wait_until "opening a Markdown link after Chinese text" grep -qFx 'https://example.invalid/span/notes?lang=zh&view=full' "$HOME/span-opened-link"
    widget mouse '消息输入框'
    xdotool type --clearmodifiers 'Draft before quotes'
    widget drag-text 'Deployment checklist'
    widget click '引用'
    widget contains 'Draft before quotes'
    [[ $(widget count '移除引用') == 1 ]]
    widget mouse '000-preview.md'
    widget click '预览'
    widget contains 'Preview code proof'
    widget bounds 'python' >/dev/null
    widget drag-text 'span_preview_marker'
    widget click '引用'
    [[ $(widget count '移除引用') == 2 ]]
    widget contains 'Draft before quotes'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-quote-preview.png"
    widget click '移除引用'
    [[ $(widget count '移除引用') == 1 ]]
    widget click '发送'
    wait_until "sending the remaining quote with the draft" test -f "$HOME/agent-quoted"
    [[ $(widget count '移除引用') == 0 ]]
    sample_memory "rendered reply with table, code and images"
    long_quote="$(sed -n '/^# Keep the full excerpt/,/^# End of the quotation fixture/p' "$HOME/000-preview.md")"
    widget drag-text "$long_quote"
    widget click '引用'
    read -r _ excerpt_y _ excerpt_height <<< "$(widget bounds "$long_quote")"
    read -r _ quote_y _ quote_height <<< "$(widget bounds '引用内容')"
    ((excerpt_height >= 58 && excerpt_y + excerpt_height <= quote_y + quote_height))
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-quote-preview.png"
    widget click '移除引用'
    widget mouse '000-source.py'
    widget click '预览'
    widget bounds '行号' >/dev/null
    widget contains '    return os.getenv("SPAN_TEST_MODE", "standard")'
    sample_memory "syntax highlighting"
    read -r preview_x preview_y _ _ <<< "$(widget bounds '预览区')"
    xdotool mousemove "$((preview_x + 90))" "$((preview_y + 175))" click --repeat 5 5
    sleep 0.2
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-source-preview.png"
    read -r row_x row_y row_width row_height <<< "$(widget bounds '000-vector.svg')"
    xdotool mousemove "$((row_x + row_width / 2))" "$((row_y + row_height / 2))" sleep 0.15 click --repeat 2 1
    widget bounds '图片画布' >/dev/null
    widget click '原始大小'
    read -r canvas_x canvas_y canvas_width _ <<< "$(widget bounds '图片画布')"
    xdotool mousemove "$((canvas_x + canvas_width / 2))" "$((canvas_y + 20))" keydown ctrl click --repeat 7 4 keyup ctrl
    widget contains '400%'
    sleep 0.2
    read -r canvas_x canvas_y canvas_width _ <<< "$(widget bounds '图片画布')"
    if [[ "$canvas_width" != 256 ]]; then
        printf 'Unexpected SVG canvas width at 400%%: %s\n' "$canvas_width" >&2
        exit 1
    fi
    xdotool mousemove 12 16
    sleep 0.2
    svg_preview="$(dirname "$WORKBENCH_PREVIEW")/svg-preview-400.png"
    import -window root "$svg_preview"
    stroke_crop="4x1+$((canvas_x + 64))+$((canvas_y + 30))"
    if [[ $(convert "$svg_preview" -crop "$stroke_crop" +repage \
        -format '%[fx:u.p{0,0}.r<0.2&&u.p{1,0}.r>0.95&&u.p{2,0}.r>0.95&&u.p{3,0}.r<0.2]' info:) != 1 ]]; then
        convert "$svg_preview" -crop "$stroke_crop" +repage txt:- >&2
        exit 1
    fi
    printf '%s\n' 'SVG zoom resolves a half-pixel source stroke into a sharp two-pixel line at 400%.'
    widget mouse '000-layout.txt'
    widget click '预览'
    widget contains 'Split workspace preview'
    printf '%s\n' 'Quote cards preserve the draft, remove independently, and send the remaining excerpt. Python preview preserves indentation with a line gutter.'
    printf '%s\n' 'Clicking Markdown links after Chinese text and inside the HTML preview opens the exact URL.'
    composer_width() {
        local input_x input_width timeline_x timeline_width center_error
        read -r input_x _ input_width _ < <(widget bounds '消息输入框')
        read -r timeline_x _ timeline_width _ < <(widget bounds '对话记录')
        center_error=$((2 * (input_x - timeline_x) + input_width - timeline_width))
        if ((center_error < -36 || center_error > 36)); then
            printf 'Composer center differs from the conversation center by %s pixels.\n' "$((center_error / 2))" >&2
            return 1
        fi
        printf '%s\n' "$input_width"
    }
    wide_width="$(composer_width)"
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-workspace.png"
    xdotool windowsize --sync "$window" 1170 940
    sleep 0.2
    narrow_width="$(composer_width)"
    ((wide_width > narrow_width + 100))
    read -r _ _ timeline_width _ < <(widget bounds '对话记录')
    read -r _ _ preview_width _ < <(widget bounds '预览区')
    if ((timeline_width < 585 || preview_width > 295)); then
        printf 'At 1170 pixels, the conversation width is %s and the preview width is %s.\n' \
            "$timeline_width" "$preview_width" >&2
        exit 1
    fi
    xdotool mousemove 15 15
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-workspace-compact.png"
    widget click '关闭预览'
    sample_memory "file preview closed"
    xdotool key --clearmodifiers ctrl+shift+f
    xdotool windowsize --sync "$window" 1250 940
    printf '%s\n' 'The centered composer adapts to both split layouts, with at least 585 pixels for conversation at 1170 pixels.'

    widget mouse 'Fast 模式'
    widget not-state 'Fast 模式' checked
    widget mouse '会话权限'
    widget mouse '完全访问'
    wait_until "selecting Full Access" dialog_open '会话权限'
    permission_dialog="$(xdotool search --onlyvisible --name '^会话权限$' | head -n1)"
    xdotool windowfocus --sync "$permission_dialog"
    widget click '启用完全访问'
    wait_until "closing the permissions confirmation" bash -c '! xdotool search --onlyvisible --name "^会话权限$" >/dev/null'
    xdotool windowfocus --sync "$window"
    widget description '会话权限' '完全访问'
    widget mouse '输入消息，或添加附件'
    xdotool type --clearmodifiers 'Check the comparison layout'
    widget click '发送'
    widget contains 'Preparing the comparison table.'
    widget not-contains '**Preparing the comparison table.**'
    widget contains '正在生成回复'
    widget state '会话权限' sensitive
    widget bounds '下一轮' >/dev/null
    widget mouse '会话权限'
    widget mouse '只读'
    widget description '会话权限' '只读。从下一轮起生效。'
    widget mouse '选择模型'
    widget mouse 'GPT Base'
    widget mouse '选择模型'
    widget mouse 'GPT Vision'
    widget mouse '思考强度'
    widget mouse '中'
    widget mouse 'Fast 模式'
    widget state 'Fast 模式' checked
    widget mouse '已完成 · 2 项活动'
    timeline_wheel 5 2
    widget contains 'Thinking after the progress update.'
    read -r _ progress_y _ _ <<< "$(widget bounds 'I found the comparison data.')"
    read -r _ after_progress_y _ _ <<< "$(widget bounds 'Thinking after the progress update.')"
    read -r _ draft_y _ _ <<< "$(widget bounds 'Preparing the comparison table.')"
    ((progress_y < after_progress_y && after_progress_y < draft_y))
    printf '%s\n' 'Fresh reasoning and commands follow an Agent progress message in the timeline.'
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
    widget mouse '进行中 · 推理摘要'
    timeline_wheel 5 3
    widget contains 'Reasoning continues below the follow-up.'
    read -r _ follow_up_y _ _ <<< "$(widget bounds 'Focus on X11')"
    read -r _ reasoning_y _ _ <<< "$(widget bounds 'Reasoning continues below the follow-up.')"
    ((reasoning_y > follow_up_y))
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-follow-up.png"
    printf '%s\n' 'Active-turn messages preserve the draft on rejection and retry on the same turn.'
    read -r stop_x stop_y stop_width stop_height < <(widget bounds '中断推理')
    ((stop_width == stop_height))
    xdotool key --clearmodifiers Escape
    read -r pause_x pause_y _ < <(widget bounds '继续推理')
    ((stop_x == pause_x && stop_y == pause_y))
    widget bounds '已停止 · 1 项活动' >/dev/null
    widget contains 'Preparing the comparison table.'
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-paused.png"
    widget mouse '输入消息，或添加附件'
    xdotool type --clearmodifiers 'Another question'
    widget bounds '发送' >/dev/null
    xdotool key --clearmodifiers ctrl+a BackSpace
    widget click '继续推理'
    widget contains 'AgentScope'
    widget bounds '发送' >/dev/null
    [[ $(widget count '下一轮') == 0 ]]

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
    timeline_wheel 5 12
    narrow_row="$(table_geometry)"
    ((narrow_row > wide_row))
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/agent-table.png"
    xdotool windowsize --sync "$window" 1250 940
    printf '%s\n' 'The composer applies both fast and standard speeds, reports elapsed task time, interrupts with Esc, and continues in place.'

    widget click '复制会话 ID'
    xclip -out -selection clipboard | grep -qx 'preview-thread'
    widget click '会话页终端面板'
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
    widget contains 'Latest deployment notes'
    if [[ -f "$HOME/agent-older-page" ]]; then
        printf '%s\n' 'An older page was requested before the user scrolled up.' >&2
        exit 1
    fi
    timeline_wheel 4 1
    wait_until "loading an older page by scrolling" test -f "$HOME/agent-older-page"
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

    sample_memory "older history rendered"
    widget click '刷新'
    widget contains '点击会话继续'
    xdotool key --clearmodifiers ctrl+shift+t
    widget contains 'Release checklist'
    catalog_requests="$(wc -l < "$HOME/agent-catalog-requests")"
    xdotool key --clearmodifiers ctrl+Page_Up
    widget contains 'Latest deployment notes'
    widget not-contains 'Release checklist'
    xdotool key --clearmodifiers ctrl+Page_Down
    widget contains 'Release checklist'
    [[ $(wc -l < "$HOME/agent-catalog-requests") -eq $catalog_requests ]]
    xdotool key --clearmodifiers ctrl+shift+w
    widget not-contains 'Release checklist'
    xdotool key --clearmodifiers ctrl+shift+f
    widget contains 'agent-older-page'
    printf 'Workspace preview fixture\n' > "$HOME/000-switch-fixture.txt"
    xdotool key --clearmodifiers ctrl+shift+t
    widget contains '000-switch-fixture.txt'
    xdotool key --clearmodifiers ctrl+Page_Up
    widget contains 'agent-older-page'
    widget not-contains '000-switch-fixture.txt'
    widget click '刷新目录'
    widget contains '000-switch-fixture.txt'
    widget mouse '000-switch-fixture.txt'
    widget state '预览' sensitive
    widget click '预览'
    widget contains 'Workspace preview fixture'
    widget state '下载' sensitive
    import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/files-preview.png"
    xdotool key --clearmodifiers ctrl+shift+f
    widget contains 'Workspace preview fixture'
    widget click '关闭预览'
    xdotool key --clearmodifiers ctrl+Page_Down ctrl+shift+w
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

    SPAN_SSH_ASKPASS=1 "$1" 'Fixture authentication challenge' > "$HOME/askpass-output" &
    askpass_pid=$!
    wait_until "the masked SSH authentication dialog" dialog_open 'SSH 身份验证'
    dialog="$(xdotool search --onlyvisible --name '^SSH 身份验证$' | head -n1)"
    xdotool windowfocus --sync "$dialog"
    xdotool type --clearmodifiers 'fixture-only-code'
    xdotool key --clearmodifiers Return
    wait "$askpass_pid"
    askpass_pid=
    grep -qx 'fixture-only-code' "$HOME/askpass-output"
    xdotool windowfocus --sync "$window"

    if [[ -n ${WORKBENCH_SSH_FIXTURE:-} ]]; then
        xdotool key --clearmodifiers ctrl+shift+o
        wait_until "the remote fixture Quick Connect dialog" dialog_open '快速连接'
        dialog="$(xdotool search --onlyvisible --name '^快速连接$' | head -n1)"
        xdotool windowfocus --sync "$dialog"
        xdotool type --clearmodifiers "ssh://$WORKBENCH_SSH_USER@127.0.0.1:$WORKBENCH_SSH_PORT"
        xdotool key --clearmodifiers Return
        xdotool windowfocus --sync "$window"
        wait_until "OpenSSH requesting host key confirmation" dialog_open 'SSH 身份验证'
        widget contains 'Are you sure you want to continue connecting'
        widget click '继续连接'
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
        widget click '会话页终端面板'
        xdotool type --clearmodifiers 'printf "%s\n" "$SSH_CONNECTION" > "$HOME/drawer-primary-connection"'
        xdotool key --clearmodifiers Return
        wait_until "the original connection in the remote terminal drawer" test -s "$WORKBENCH_SSH_FIXTURE/drawer-primary-connection"
        widget click '在面板中新建终端'
        widget state '关闭底部终端' sensitive
        xdotool type --clearmodifiers 'printf "%s\n" "$SSH_CONNECTION" > "$HOME/drawer-extra-connection"; seq 1 160'
        xdotool key --clearmodifiers Return
        wait_until "a second remote terminal in the drawer" test -s "$WORKBENCH_SSH_FIXTURE/drawer-extra-connection"
        cmp "$WORKBENCH_SSH_FIXTURE/drawer-primary-connection" "$WORKBENCH_SSH_FIXTURE/drawer-extra-connection"
        [[ $(sort -u "$WORKBENCH_SSH_FIXTURE/remote-shells" | wc -l) -eq 2 ]]
        sleep 0.2
        import -window "$window" "$(dirname "$WORKBENCH_PREVIEW")/remote-terminal-drawer.png"
        widget click '关闭底部终端'
        widget not-state '关闭底部终端' sensitive
        xdotool type --clearmodifiers 'printf "%s\n" "$SSH_CONNECTION" > "$HOME/drawer-returned-connection"'
        xdotool key --clearmodifiers Return
        wait_until "input returned to the original remote terminal" test -s "$WORKBENCH_SSH_FIXTURE/drawer-returned-connection"
        cmp "$WORKBENCH_SSH_FIXTURE/drawer-primary-connection" "$WORKBENCH_SSH_FIXTURE/drawer-returned-connection"
        widget click '会话页终端面板'
        printf '%s\n' 'The drawer plus button opens a second SSH shell on the same connection, and closing it returns focus to the first shell.'
        ssh_socket="$(find "$TMPDIR" -type s -path '*/swb-*/ssh' -print -quit)"
        test -S "$ssh_socket"
        ssh -F /dev/null -S "$ssh_socket" -O exit localhost
        widget click '重新连接'
        resumed_twice() { [[ $(wc -l < "$WORKBENCH_SSH_FIXTURE/agent-resumed") -eq 2 ]]; }
        wait_until "automatic restoration on SSH reconnect" resumed_twice
        widget contains 'Latest deployment notes'
        widget description '会话权限' '只读'
        widget mouse '会话权限'
        widget mouse '工作区权限'
        add_attachment "$HOME/notes.txt"
        paste_image
        xdotool type --clearmodifiers 'Read the remote attachment'
        xdotool key --clearmodifiers ctrl+Return
        wait_until "remote file attachment bytes, permissions, and path" test -f "$WORKBENCH_SSH_FIXTURE/agent-uploaded"
        printf '%s\n' 'Composer controls share the same centerline, and permission changes reach the local and remote Codex servers.'
        printf '%s\n' 'Span used the remote shared Codex socket, received external turn events and reopened the same session after SSH reconnect.'
        printf '%s\n' 'Picker files, model and effort overrides, token and account usage, and remote attachment uploads passed.'
    fi
fi
