#!/usr/bin/env bash
set -euo pipefail

span="$1"
executable="$2"
backend="${3:-codex}"
case "$backend" in
    codex|clue) ;;
    *) printf 'Unknown App Server backend %s\n' "$backend" >&2; exit 2 ;;
esac
fixture="$(mktemp -d)"
agent_home="$fixture/$backend"
app_pid=
widget_pid=
display_pid=
gateway_pid=
cleanup() {
    if [[ $1 != 0 ]]; then
        for log in "$fixture"/{span,gateway}.log; do
            if [[ -f "$log" ]]; then cat "$log" >&2; fi
        done
        if [[ -f "$fixture/wire.log" ]]; then
            grep -E '"type":"fileChange"|"method":"turn/diff/updated"' \
                "$fixture/wire.log" | tail -n 12 >&2 || true
        fi
        if [[ -d "$agent_home/log" ]]; then
            find "$agent_home/log" -type f -exec tail -n 50 {} \; >&2
        fi
    fi
    for pid in "$app_pid" "$widget_pid" "$display_pid" "$gateway_pid"; do
        if [[ -n "$pid" ]]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
    rm -rf -- "$fixture"
}
trap 'cleanup "$?"' EXIT

export HOME="$fixture/home" XDG_CONFIG_HOME="$fixture/config" XDG_DATA_HOME="$fixture/data"
export CODEX_HOME="$fixture/codex" CLUE_HOME="$fixture/clue" TMPDIR="$fixture/tmp" GDK_BACKEND=x11
export GTK_IM_MODULE=gtk-im-context-simple
unset NO_AT_BRIDGE
mkdir -p "$HOME" "$agent_home" "$TMPDIR" "$fixture/workspace" "$fixture/bin"
git init --quiet "$fixture/workspace"
export SPAN_TEST_APP_SERVER="$executable" SPAN_TEST_WIRE_LOG="$fixture/wire.log"
export PATH="$fixture/bin:$PATH"
cat > "$fixture/bin/$backend" <<'SCRIPT'
#!/bin/bash
set -o pipefail
"$SPAN_TEST_APP_SERVER" "$@" | tee -a "$SPAN_TEST_WIRE_LOG"
SCRIPT
chmod +x "$fixture/bin/$backend"

wait_for() {
    local check="$1"
    shift
    for _ in {1..150}; do
        if "$check" "$@"; then return; fi
        sleep 0.1
    done
    printf 'Timed out waiting for %s %s.\n' "$check" "$*" >&2
    exit 1
}

python3.9 packaging/test-responses-gateway.py "$fixture/port" >"$fixture/gateway.log" 2>&1 &
gateway_pid=$!
wait_for test -s "$fixture/port"
cat > "$agent_home/config.toml" <<CONFIG
model = "span-ci-model"
model_provider = "span_ci"
[features]
shell_snapshot = false
[model_providers.span_ci]
name = "Span CI Responses Gateway"
base_url = "http://127.0.0.1:$(cat "$fixture/port")/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
CONFIG

Xvfb -displayfd 3 -screen 0 1440x960x24 -nolisten tcp 3>"$fixture/display" &
display_pid=$!
wait_for test -s "$fixture/display"
export DISPLAY=":$(cat "$fixture/display")"

widget_socket="$fixture/widgets.sock"
/usr/libexec/platform-python packaging/test-widget.py --serve "$widget_socket" &
widget_pid=$!
wait_for test -S "$widget_socket"
widget() { /usr/libexec/platform-python packaging/test-widget.py --request "$widget_socket" "$@"; }

open_span() {
    "$span" >>"$fixture/span.log" 2>&1 &
    app_pid=$!
    timeout 20s xdotool search --sync --onlyvisible --pid "$app_pid" --name '^Span$' windowfocus
    widget click '切换 Codex 会话／终端'
    if [[ $backend == clue ]]; then
        xdotool key --clearmodifiers ctrl+shift+h
        widget click '会话后端 · Clue'
        widget state '打开会话' sensitive
    fi
}
send() {
    widget set-text '消息输入框' "$1"
    widget click '发送'
}

open_span
widget set-text '工作目录' "$fixture/workspace"
widget click '打开会话'
widget description '选择模型' 'span-ci-model'
widget description '会话权限' '工作区权限'
send 'Create the fixture file.'
widget contains '命令执行审批'
test ! -e "$fixture/workspace/span-ci-approval.txt"
test ! -e "$fixture/workspace/span-ci-result.txt"
widget click '允许一次'

patch_started() {
    [[ -f "$fixture/workspace/span-ci-result.txt" ]] ||
        [[ "$(widget count '文件变更审批')" -eq 1 ]]
}
wait_for patch_started 'file change or sandbox retry'
if [[ ! -e "$fixture/workspace/span-ci-result.txt" ]]; then
    # Default Docker policy can prevent bubblewrap from starting. The backend
    # must ask before retrying the change, and the test grants only that retry.
    widget contains '文件变更审批'
    widget contains 'command failed; retry without sandbox?'
    test ! -e "$fixture/workspace/span-ci-result.txt"
    widget click '允许一次'
    printf '%s\n' 'The container required an explicit file-change approval for the sandbox retry.'
fi
widget contains 'Fixture file created.'
widget bounds '复制本轮 Markdown' >/dev/null
grep -qx 'approved' "$fixture/workspace/span-ci-approval.txt"
grep -qx 'Patched by the App Server.' "$fixture/workspace/span-ci-result.txt"
widget click '关闭预览'
change="修改文件 · $fixture/workspace/span-ci-result.txt"
widget expand "$change"
widget state "$change" expanded
widget expanded-contains "$change" '+Patched by the App Server.'
widget click '复制会话 ID'
session="$(xclip -out -selection clipboard)"
[[ "$session" =~ ^[[:xdigit:]-]+$ ]]

# The second process must recover the conversation from the real server's storage.
kill "$app_pid"
wait "$app_pid" || true
app_pid=
open_span
widget set-text '会话 ID' "$session"
widget click '打开会话'
widget contains 'Fixture file created.'
send 'Continue the existing fixture session.'
widget contains 'Fixture session continued.'
printf 'The EL8 Span RPM handled approval, displayed a diff and resumed the same session with %s.\n' "$backend"
