#!/usr/bin/env bash
set -euo pipefail

test_home="$(mktemp -d)"
app_pid=
cleanup() {
    if [[ -n "$app_pid" ]]; then
        kill "$app_pid" 2>/dev/null || true
        wait "$app_pid" 2>/dev/null || true
    fi
    rm -rf -- "$test_home"
}
trap cleanup EXIT

export HOME="$test_home"
export GDK_BACKEND=x11 GSK_RENDERER=cairo GTK_A11Y=none
cat > "$HOME/.bash_profile" <<'PROFILE'
printf '%s\n' 'Bash started under VTE' > "$HOME/bash-ready"
PROFILE

"$1" &
app_pid=$!
for _ in {1..100}; do
    kill -0 "$app_pid"
    if [[ -s "$HOME/bash-ready" ]] && xdotool search --onlyvisible --name '^SSH Workbench$' >/dev/null; then
        printf '%s\n' 'GTK window opened with Cairo and the local Bash PTY started.'
        exit 0
    fi
    sleep 0.1
done

printf '%s\n' 'Unable to verify the GTK window and local Bash PTY.' >&2
exit 1
