#!/usr/bin/env bash
set -euo pipefail

test_home="$(mktemp -d)"
app_pid=
xvfb_pid=
cleanup() {
    if [[ $1 != 0 && -f "$test_home/app.log" ]]; then
        cat "$test_home/app.log" >&2
        xwininfo -root -tree >&2 || true
    fi
    for pid in "$app_pid" "$xvfb_pid"; do
        if [[ -n "$pid" ]]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
    rm -rf -- "$test_home"
}
trap 'cleanup "$?"' EXIT

export HOME="$test_home" XDG_CONFIG_HOME="$test_home/.config" GDK_BACKEND=x11 NO_AT_BRIDGE=1
cat > "$HOME/.bash_profile" <<'PROFILE'
printf '%s\n' "$BASHPID" >> "$HOME/bash-ready"
PS1='\[\e[38;5;79m\]\u@local\[\e[0m\]:\w\$ '
PROFILE

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

Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp -noreset 3>"$HOME/display" &
xvfb_pid=$!
wait_until "the Xvfb display" test -s "$HOME/display"
export DISPLAY=":$(cat "$HOME/display")"

"$1" >"$HOME/app.log" 2>&1 &
app_pid=$!
window_exists() {
    kill -0 "$app_pid" 2>/dev/null &&
        xwininfo -root -tree | grep -F '"SSH Workbench"' >/dev/null
}
wait_until "the GTK3 window" window_exists
wait_until "the local Bash PTY" test -s "$HOME/bash-ready"
if grep -q 'Failed to load Workbench theme' "$HOME/app.log"; then
    exit 1
fi
printf '%s\n' 'GTK3 window opened on virtual X11 and the local Bash PTY started.'

if [[ $# -eq 2 ]]; then
    LD_LIBRARY_PATH=/usr/lib64/ssh-workbench "$2"
fi

if [[ -n ${WORKBENCH_PREVIEW:-} ]]; then
    window="$(xdotool search --onlyvisible --name '^SSH Workbench$' | head -n 1)"
    xdotool windowfocus --sync "$window"
    first_bash="$(head -n1 "$HOME/bash-ready")"
    awk '/^VmRSS:/ { print "Idle application RSS with one Bash tab (Xvfb): " $2 " KiB" }' "/proc/$app_pid/status"

    xdotool key --clearmodifiers ctrl+shift+t
    second_bash_started() {
        [[ $(wc -l < "$HOME/bash-ready") -eq 2 ]]
    }
    wait_until "a second Bash tab" second_bash_started

    xdotool key --clearmodifiers ctrl+shift+n
    dialog_open() {
        xdotool search --onlyvisible --name "^$1$" >/dev/null
    }
    wait_until "the Add Host dialog" dialog_open '添加主机'
    dialog="$(xdotool search --onlyvisible --name '^添加主机$' | head -n1)"
    xdotool windowfocus --sync "$dialog"
    xdotool type --clearmodifiers 'ci-host'
    xdotool key --clearmodifiers shift+Tab
    xdotool type --clearmodifiers 'CI Host'
    xdotool key --clearmodifiers Return
    profile="$XDG_CONFIG_HOME/ssh-workbench/hosts.ini"
    wait_until "the saved SSH target" grep -qs '^target=ci-host$' "$profile"
    grep -qx 'name=CI Host' "$profile"
    grep -qx 'trusted-x11=false' "$profile"

    xdotool windowfocus --sync "$window"
    xdotool mousemove 1250 770
    import -window "$window" "$WORKBENCH_PREVIEW"
    xdotool key --clearmodifiers ctrl+shift+w
    xdotool type --clearmodifiers 'printf "%s\\n" "$BASHPID" > "$HOME/current-bash"'
    xdotool key --clearmodifiers Return
    wait_until "returning to the first Bash tab" grep -qsx "$first_bash" "$HOME/current-bash"

    # OpenSSH reads the temporary config for the CI runner's real user via passwd.
    ssh_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
    ssh_config="$ssh_home/.ssh/config"
    mkdir -p "$ssh_home/.ssh"
    backup="$(mktemp)"
    if [[ -f "$ssh_config" ]]; then
        cp -p "$ssh_config" "$backup"
    fi
    printf 'Host ci-host\n    ProxyCommand echo launched > %s/ssh-ready; exit 1\n\n' "$HOME" > "$backup.new"
    cat "$backup" >> "$backup.new"
    install -m 0600 "$backup.new" "$ssh_config"
    restore_ssh() {
        if [[ -s "$backup" ]]; then
            install -m 0600 "$backup" "$ssh_config"
        else
            rm -f "$ssh_config"
        fi
        rm -f "$backup" "$backup.new"
    }
    trap 'result=$?; restore_ssh; cleanup "$result"' EXIT

    xdotool key --clearmodifiers ctrl+shift+o
    wait_until "the Quick Connect dialog" dialog_open '快速连接'
    dialog="$(xdotool search --onlyvisible --name '^快速连接$' | head -n1)"
    xdotool windowfocus --sync "$dialog"
    xdotool type --clearmodifiers 'ci-host'
    xdotool key --clearmodifiers Return
    wait_until "OpenSSH using the configured alias" test -s "$HOME/ssh-ready"
    printf '%s\n' 'Tab creation/closing, host creation/persistence and system OpenSSH all passed.'
fi
