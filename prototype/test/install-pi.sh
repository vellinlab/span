#!/usr/bin/env bash
set -euo pipefail

prefix="$1"
mkdir -p "$prefix"
release=https://github.com/earendil-works/pi/releases/download/v1.6.0
curl -fsSL --retry 3 "$release/pi-coding-agent-install-package.json" -o "$prefix/package.json"
curl -fsSL --retry 3 "$release/pi-coding-agent-install-package-lock.json" -o "$prefix/package-lock.json"
(
    cd "$prefix"
    printf '%s  %s\n' \
        4b61ca991909e436adf8238af90e865314dd32354d58f2e20ebfa8cc419e1baf package.json \
        11fa077f9cde7b5b2b6c1341dd31dbf1bc88ce5e432c1ad7cd5f84618259d2dd package-lock.json \
        | sha256sum --check -
)
npm ci --prefix "$prefix" --no-audit --no-fund

teams_archive="$prefix/pi-teams-1.0.7.tgz"
curl -fsSL --retry 3 https://registry.npmjs.org/@vadimcomanescu/pi-teams/-/pi-teams-1.0.7.tgz -o "$teams_archive"
printf '%s  %s\n' 4546aa9e1ba36062ff1f0ea8f7f66295c081f5467bbcaee05fb7972d1d2bdc2e "$teams_archive" | sha256sum --check -
mkdir -p "$prefix/team-state-fixture"
tar -xf "$teams_archive" -C "$prefix/team-state-fixture" --strip-components=1
