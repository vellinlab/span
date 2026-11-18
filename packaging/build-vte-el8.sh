#!/usr/bin/env bash
set -euo pipefail

version=0.64.2
archive="vte-$version.tar.xz"
source_url="https://download.gnome.org/sources/vte/0.64/$archive"
build_dir="$(mktemp -d)"
staging_dir="$PWD/target/bundled-vte"
mkdir -p "$staging_dir" dist

curl -fsSL --retry 3 "$source_url" -o "$build_dir/$archive"
(
    cd "$build_dir"
    printf '%s  %s\n' 2b3c820b65a667c1d8859ba20478be626d1519cc3159dac25f703330c6d07e18 "$archive" | sha256sum -c -
    tar -xf "$archive"
)

src="$build_dir/vte-$version"
meson setup "$build_dir/build" "$src" \
    --prefix=/usr --libdir=lib64 --buildtype=release \
    -Dgtk4=false -Dgir=false -Dvapi=false -Ddocs=false -Dglade=false -Dicu=false -D_systemd=false
ninja -C "$build_dir/build" -j 2 src/libvte-2.91.so.0.6400.2
install -m 0755 "$build_dir/build/src/libvte-2.91.so.0.6400.2" "$staging_dir/libvte-2.91.so.0"
install -m 0644 "$src"/COPYING.* "$staging_dir"
printf 'VTE %s is bundled unmodified. Upstream source: %s\n' "$version" "$source_url" > "$staging_dir/SOURCE"
cp "$build_dir/$archive" dist/
