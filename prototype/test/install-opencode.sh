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
        archive=opencode-linux-x64-baseline-musl.tar.gz
        digest=bc6b0d702163d859161ee8e43ea3f16d1bd43b305ac7ce17742eb01ba72489f3
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
fi
