#!/usr/bin/env bash
set -euo pipefail

fixture="$1"
mkdir -p "$fixture/backend" "$fixture/bin" "$fixture/codex-state"
read -r tag sha < packaging/app-server-baseline
archive=codex-package-x86_64-unknown-linux-musl.tar.gz
curl -fLsS --retry 3 "https://github.com/openai/codex/releases/download/$tag/$archive" -o "$fixture/$archive"
printf '%s  %s\n' "$sha" "$fixture/$archive" | sha256sum --check -
tar -xzf "$fixture/$archive" -C "$fixture/backend"
backend="$(find "$fixture/backend" -type f -name codex -print -quit)"
test -x "$backend"
ln -s "$backend" "$fixture/bin/codex"

python3.9 packaging/test-responses-gateway.py "$fixture/port" >"$fixture/gateway.log" 2>&1 &
gateway=$!
local_shared=
remote_shared=
trap 'kill "$gateway" ${local_shared:+$local_shared} ${remote_shared:+$remote_shared} 2>/dev/null || true
      cat "$fixture/gateway.log"
      for log in "$fixture/local-shared.log" "$fixture/remote-shared.log"; do
          if [[ -f "$log" ]]; then tail -60 "$log"; fi
      done' EXIT
for _ in {1..50}; do [[ -s "$fixture/port" ]] && break; sleep 0.1; done
cat > "$fixture/codex-state/config.toml" <<CONFIG
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
export PATH="$fixture/bin:$PATH" CODEX_HOME="$fixture/codex-state"
binary=/artifacts/linux/span-preview

ready_socket() {
    local socket="$1" process="$2" log="$3"
    for _ in {1..80}; do
        if [[ -S "$socket" ]] && kill -0 "$process"; then return; fi
        sleep 0.1
    done
    cat "$log" >&2
    return 1
}

/artifacts/node prototype/test/real-agent.mjs "$binary" stdio --image --diff --review
install -d -m 0700 "$CODEX_HOME/app-server-control"
socket="$CODEX_HOME/app-server-control/app-server-control.sock"
python3.9 -c 'import socket, sys; sock = socket.socket(socket.AF_UNIX); sock.bind(sys.argv[1]); sock.close()' "$socket"
/artifacts/node prototype/test/real-agent.mjs "$binary" stdio
rm "$socket"

"$backend" app-server --listen unix:// >"$fixture/local-shared.log" 2>&1 &
local_shared=$!
ready_socket "$socket" "$local_shared" "$fixture/local-shared.log"
/artifacts/node prototype/test/real-agent.mjs "$binary" shared
kill -0 "$local_shared"

if [[ -n ${SPAN_TEST_SSH_ALIAS:-} ]]; then
    remote_state=/home/span-preview-ci/.codex
    install -d -m 0700 -o span-preview-ci "$remote_state"
    install -d -m 0755 -o span-preview-ci /home/span-preview-ci/.local /home/span-preview-ci/.local/bin
    ln -s "$backend" /home/span-preview-ci/.local/bin/codex
    install -m 0600 -o span-preview-ci "$CODEX_HOME/config.toml" "$remote_state/config.toml"
    /artifacts/node prototype/test/real-agent.mjs "$binary" stdio "$SPAN_TEST_SSH_ALIAS"

    runuser -u span-preview-ci -- bash -c 'cd "$HOME" && exec "$@"' span-codex \
        env CODEX_HOME="$remote_state" "$backend" app-server --listen unix:// >"$fixture/remote-shared.log" 2>&1 &
    remote_shared=$!
    ready_socket "$remote_state/app-server-control/app-server-control.sock" "$remote_shared" "$fixture/remote-shared.log"
    /artifacts/node prototype/test/real-agent.mjs "$binary" shared "$SPAN_TEST_SSH_ALIAS"
    kill -0 "$remote_shared"
fi
