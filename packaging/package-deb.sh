#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$(mktemp -d)"
trap 'rm -rf -- "$workspace"' EXIT
version="$(bash "$root/packaging/package-version.sh")"
arch="$(dpkg --print-architecture)"
package="$workspace/package"

install -D -m 0755 "$root/target/release/span" "$package/usr/bin/span"
ln -s span "$package/usr/bin/ssh-workbench"
install -D -m 0644 "$root/packaging/io.github.zyw02.SshWorkbench.desktop" \
    "$package/usr/share/applications/io.github.zyw02.SshWorkbench.desktop"
cp -a "$root/packaging/icons" "$package/usr/share/"

cd "$workspace"
mkdir -p debian "$package/DEBIAN"
cat > debian/control <<'CONTROL'
Source: span
Section: utils
Priority: optional
Maintainer: Span maintainers <zyw02@users.noreply.github.com>

Package: span
Architecture: any
Description: Span SSH terminal and Codex workspace
CONTROL

libraries="$(dpkg-shlibdeps -O -e"$package/usr/bin/span" | sed -n 's/^shlibs:Depends=//p')"
test -n "$libraries"
cat > "$package/DEBIAN/control" <<CONTROL
Package: span
Version: $version
Architecture: $arch
Section: utils
Priority: optional
Maintainer: Span maintainers <zyw02@users.noreply.github.com>
Depends: bash, coreutils, openssh-client, librsvg2-common, $libraries
Recommends: xauth
Provides: ssh-workbench
Conflicts: ssh-workbench
Replaces: ssh-workbench
Description: Span SSH terminal and Codex workspace
 Manage SSH hosts and switch between local and remote terminal tabs.
CONTROL

mkdir -p "$root/dist"
dpkg-deb --root-owner-group --build "$package" "$root/dist/span_${version}_${arch}.deb"
