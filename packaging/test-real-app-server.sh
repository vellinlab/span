#!/usr/bin/env bash
set -euo pipefail

span="$1"
codex="$2"
fixture="$(mktemp -d)"
app_pid=
widget_pid=
display_pid=
gateway_pid=
cleanup() {
    if [[ $1 != 0 ]]; then
        cat "$fixture"/{span,gateway}.log >&2
        if [[ -d "$CODEX_HOME/log" ]]; then
            find "$CODEX_HOME/log" -type f -exec tail -n 50 {} \; >&2
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
export CODEX_HOME="$fixture/codex" TMPDIR="$fixture/tmp" GDK_BACKEND=x11
export PATH="$(dirname "$codex"):$PATH"
export GTK_IM_MODULE=gtk-im-context-simple
unset NO_AT_BRIDGE
mkdir -p "$HOME" "$CODEX_HOME" "$TMPDIR" "$fixture/workspace"
git init --quiet "$fixture/workspace"

wait_for() {
    local check="$1"
    shift
    for _ in {1..150}; do
        if "$check" "$@"; then return; fi
        sleep 0.1
    done
    printf 'Timed out waiting for %s.\n' "$*" >&2
    exit 1
}

python3.9 packaging/test-responses-gateway.py "$fixture/port" >"$fixture/gateway.log" 2>&1 &
gateway_pid=$!
wait_for test -s "$fixture/port"
cat > "$CODEX_HOME/config.toml" <<CONFIG
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
/usr/bin/python3 packaging/test-widget.py --serve "$widget_socket" &
widget_pid=$!
wait_for test -S "$widget_socket"
widget() { /usr/bin/python3 packaging/test-widget.py --request "$widget_socket" "$@"; }

open_span() {
    "$span" >>"$fixture/span.log" 2>&1 &
    app_pid=$!
    timeout 20s xdotool search --sync --onlyvisible --pid "$app_pid" --name '^Span$' windowfocus
    widget click '切换 Codex 会话／终端'
}
send() {
    widget set-text '消息输入框' "$1"
    widget click '发送'
}

open_span
widget set-text '工作目录' "$fixture/workspace"
widget click '打开会话'
widget state '选择模型' sensitive
widget description '会话权限' '工作区权限'
send 'Create the fixture file.'
widget contains '命令执行审批'
test ! -e "$fixture/workspace/span-ci-approval.txt"
test ! -e "$fixture/workspace/span-ci-result.txt"
widget click '允许一次'
widget contains 'Fixture file created.'
grep -qx 'approved' "$fixture/workspace/span-ci-approval.txt"
grep -qx 'Patched by the App Server.' "$fixture/workspace/span-ci-result.txt"
widget mouse '本轮变更 · 查看 diff'
widget contains '+Patched by the App Server.'
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
printf '%s\n' 'The EL8 Span RPM opened, handled command approval, displayed a file diff, and resumed the same session with a real App Server.'
