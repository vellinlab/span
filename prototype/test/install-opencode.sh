#!/usr/bin/env bash
set -euo pipefail

platform="$1"
destination="$2"
tag=v1.19.6
case "$platform" in
    windows)
        archive=opencode-windows-x64-baseline.zip
        digest=d4fc63f09bd14ee2308c05d34c231a8d09c3e945fd2e86ef4ea1a41b31dd1830
        ;;
    linux)
        archive=opencode-linux-x64-baseline.tar.gz
        digest=8443113b3f3dfebf8b0fa91c4377e5519a62b9231732d9344a5df001e4a852b3
        ;;
    *) exit 2 ;;
esac

mkdir -p "$destination"
curl -fLsS --retry 3 "https://github.com/anomalyco/opencode/releases/download/$tag/$archive" -o "$destination/$archive"
printf '%s  %s\n' "$digest" "$destination/$archive" | sha256sum --check -
if [[ "$platform" == windows ]]; then
    /c/Windows/System32/tar.exe -xf "$destination/$archive" -C "$destination"
    test -f "$destination/opencode.exe"
else
    tar -xzf "$destination/$archive" -C "$destination"
    test -x "$destination/opencode"
    "$destination/opencode" --version
fi
