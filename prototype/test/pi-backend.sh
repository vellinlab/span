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
    install -d -m 0700 -o span-preview-ci "$remote_temp" "$remote_temp/bin"
    cat > "$remote_temp/bin/dd" <<'SCRIPT'
#!/bin/bash
gate="$HOME/.span-pi-test-tmp/hold-team-block"
if mv -- "$gate" "$gate.reading" 2>/dev/null; then
    for _ in {1..300}; do
        [[ -e "$gate.reading" ]] || break
        sleep 0.05
    done
fi
exec /usr/bin/dd "$@"
SCRIPT
    chmod 0755 "$remote_temp/bin/dd"
    cat > /home/span-preview-ci/.local/bin/pi <<SCRIPT
#!/bin/sh
export PI_CODING_AGENT_DIR="$remote_state"
export TMPDIR="$remote_temp"
export PATH="\$HOME/.local/bin:\$PATH"
exec /artifacts/node "$pi_cli" "\$@"
SCRIPT
    chmod 0755 /home/span-preview-ci/.local/bin/pi
    SPAN_TEST_PI_STATE="$remote_state" SPAN_TEST_PI_READ_GATE="$remote_temp/hold-team-block" \
        /artifacts/node prototype/test/real-pi.mjs \
        "$binary" "$fixture/pi" /artifacts/el8-pi-ssh.png "$SPAN_TEST_SSH_ALIAS"
fi
