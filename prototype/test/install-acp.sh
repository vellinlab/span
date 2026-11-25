#!/usr/bin/env bash
set -euo pipefail

backend="$1"
platform="$2"
destination="$3"
case "$backend" in
    opencode) repository=anomalyco/opencode; tag=v1.19.6 ;;
    kilo) repository=Kilo-Org/kilocode; tag=v7.8.32 ;;
    *) exit 2 ;;
esac
case "$backend/$platform" in
    opencode/windows)
        digest=d4fc63f09bd14ee2308c05d34c231a8d09c3e945fd2e86ef4ea1a41b31dd1830
        ;;
    opencode/linux)
        digest=8443113b3f3dfebf8b0fa91c4377e5519a62b9231732d9344a5df001e4a852b3
        ;;
    kilo/windows) digest=4f1f542baa28f21fbb4801dd01be661f4a164c27042c8156b3237ff15c7e4c59 ;;
    kilo/linux) digest=ab7a008a2c0ca6e035b96cd1dc5712a8466a14a45992291a8f0b4b549b94136e ;;
    *) exit 2 ;;
esac
suffix=tar.gz
if [[ "$platform" == windows ]]; then suffix=zip; fi
archive="$backend-$platform-x64-baseline.$suffix"

mkdir -p "$destination"
curl -fLsS --retry 3 "https://github.com/$repository/releases/download/$tag/$archive" -o "$destination/$archive"
printf '%s  %s\n' "$digest" "$destination/$archive" | sha256sum --check -
if [[ "$platform" == windows ]]; then
    /c/Windows/System32/tar.exe -xf "$destination/$archive" -C "$destination"
    test -f "$destination/$backend.exe"
else
    tar -xzf "$destination/$archive" -C "$destination"
    test -x "$destination/$backend"
    "$destination/$backend" --version
fi
