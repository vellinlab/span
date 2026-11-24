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
