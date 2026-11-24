#!/usr/bin/env bash
set -euo pipefail

fixture="$1"
binary=/artifacts/linux/span-preview
pi_cli=/artifacts/pi-test/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
cat > "$fixture/pi" <<SCRIPT
#!/bin/sh
exec /artifacts/node "$pi_cli" "\$@"
SCRIPT
chmod 0755 "$fixture/pi"

/artifacts/node prototype/test/real-pi.mjs "$binary" "$fixture/pi" /artifacts/el8-pi.png

if [[ -n ${SPAN_TEST_SSH_ALIAS:-} ]]; then
    remote_state="/home/span-preview-ci/.span Pi's fixture"
    install -d -m 0755 -o span-preview-ci /home/span-preview-ci/.local/bin
    cat > /home/span-preview-ci/.local/bin/pi <<SCRIPT
#!/bin/sh
export PI_CODING_AGENT_DIR="$remote_state"
exec /artifacts/node "$pi_cli" "\$@"
SCRIPT
    chmod 0755 /home/span-preview-ci/.local/bin/pi
    SPAN_TEST_PI_STATE="$remote_state" /artifacts/node prototype/test/real-pi.mjs \
        "$binary" "$fixture/pi" /artifacts/el8-pi-ssh.png "$SPAN_TEST_SSH_ALIAS"
fi
