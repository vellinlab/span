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
trap 'kill "$gateway"; cat "$fixture/gateway.log"' EXIT
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
PATH="$fixture/bin:$PATH" CODEX_HOME="$fixture/codex-state" \
    /artifacts/node prototype/test/real-agent.mjs /artifacts/linux/span-preview
