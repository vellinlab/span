#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$(mktemp -d)"
trap 'rm -rf -- "$workspace"' EXIT
version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$root/Cargo.toml")"
arch="$(dpkg --print-architecture)"
package="$workspace/package"

install -D -m 0755 "$root/target/release/ssh-workbench" "$package/usr/bin/ssh-workbench"
install -D -m 0644 "$root/packaging/io.github.zyw02.SshWorkbench.desktop" \
    "$package/usr/share/applications/io.github.zyw02.SshWorkbench.desktop"

cd "$workspace"
mkdir -p debian "$package/DEBIAN"
cat > debian/control <<'CONTROL'
Source: ssh-workbench
Section: utils
Priority: optional
Maintainer: SSH Workbench maintainers <zyw02@users.noreply.github.com>

Package: ssh-workbench
Architecture: any
Description: A desktop terminal for local shells and OpenSSH sessions
CONTROL

libraries="$(dpkg-shlibdeps -O -e"$package/usr/bin/ssh-workbench" | sed -n 's/^shlibs:Depends=//p')"
test -n "$libraries"
cat > "$package/DEBIAN/control" <<CONTROL
Package: ssh-workbench
Version: $version
Architecture: $arch
Section: utils
Priority: optional
Maintainer: SSH Workbench maintainers <zyw02@users.noreply.github.com>
Depends: bash, openssh-client, $libraries
Recommends: xauth
Description: A desktop terminal for local shells and OpenSSH sessions
 Control both terminals from a split GTK window.
CONTROL

mkdir -p "$root/dist"
dpkg-deb --root-owner-group --build "$package" "$root/dist/ssh-workbench_${version}_${arch}.deb"
