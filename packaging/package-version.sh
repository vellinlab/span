#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$root/Cargo.toml")"
test -n "$version"
# RPM and Debian sort a tilde prerelease before the corresponding stable version.
printf '%s\n' "${version/-/\~}"
