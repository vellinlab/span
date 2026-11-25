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
export SPAN_TEST_PI_TEAMS=/artifacts/pi-test/team-state-fixture
export PATH="$fixture:$PATH"

/artifacts/node prototype/test/real-pi.mjs "$binary" "$fixture/pi" /artifacts/el8-pi.png

if [[ -n ${SPAN_TEST_SSH_ALIAS:-} ]]; then
    remote_state="/home/span-preview-ci/.span Pi's fixture"
    remote_temp=/home/span-preview-ci/.span-pi-test-tmp
    install -d -m 0755 -o span-preview-ci /home/span-preview-ci/.local/bin
    # Pi Teams creates fixed names under os.tmpdir(). The local fixture runs as root on this runner.
    install -d -m 0700 -o span-preview-ci "$remote_temp"
    cat > /home/span-preview-ci/.local/bin/pi <<SCRIPT
#!/bin/sh
export PI_CODING_AGENT_DIR="$remote_state"
export TMPDIR="$remote_temp"
export PATH="\$HOME/.local/bin:\$PATH"
exec /artifacts/node "$pi_cli" "\$@"
SCRIPT
    chmod 0755 /home/span-preview-ci/.local/bin/pi
    SPAN_TEST_PI_STATE="$remote_state" /artifacts/node prototype/test/real-pi.mjs \
        "$binary" "$fixture/pi" /artifacts/el8-pi-ssh.png "$SPAN_TEST_SSH_ALIAS"
fi
