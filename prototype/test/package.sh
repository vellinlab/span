#!/usr/bin/env bash
set -euo pipefail
platform=$1
binary=$2
target=$3
version=45.4.1
case "$platform" in
    linux)
        sha=e1d077c7a087d7e344350ea0c5cd2b7dc5af3d9bf7979474f38e0fc1a560b875
        executable=electron
        ;;
    win32)
        sha=2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9
        executable=electron.exe
        ;;
    *) exit 2 ;;
esac
archive="electron-v$version-$platform-x64.zip"
runtime="$(mktemp -d)"
trap 'rm -rf -- "$runtime"' EXIT
curl -fLsS --retry 3 "https://github.com/electron/electron/releases/download/v$version/$archive" -o "$runtime/$archive"
printf '%s  %s\n' "$sha" "$runtime/$archive" | sha256sum --check -
mkdir -p "$target"
unzip -q "$runtime/$archive" -d "$target"
mv "$target/$executable" "$target/${executable/electron/span-preview}"
app="$target/resources/app"
mkdir -p "$app/bin"
cp -R prototype/dist prototype/desktop prototype/sample prototype/package.json "$app"
cp "$binary" "$app/bin/"
if [ "$platform" = win32 ]; then
    cp windows/span.ico "$app/"
    editor="$runtime/rcedit-x64.exe"
    curl -fLsS --retry 3 https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe -o "$editor"
    printf '%s  %s\n' 3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a "$editor" | sha256sum --check
    "$editor" "$(cygpath -w "$target/span-preview.exe")" --set-icon "$(cygpath -w windows/span.ico)"
fi
