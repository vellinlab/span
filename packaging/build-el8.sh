#!/usr/bin/env bash
set -euo pipefail

dnf --enablerepo=powertools --setopt=install_weak_deps=False -y install \
    gcc binutils ca-certificates curl pkgconf-pkg-config rpm-build desktop-file-utils \
    gtk3-devel vte291-devel openssh-clients dbus-daemon xorg-x11-server-Xvfb xorg-x11-utils

curl -fsSL --retry 3 https://sh.rustup.rs -o /tmp/ssh-workbench-rustup.sh
bash /tmp/ssh-workbench-rustup.sh -y --profile minimal --default-toolchain 1.98.1 --component rustfmt
export PATH="$HOME/.cargo/bin:$PATH"

if [[ ! -f Cargo.lock ]]; then
    cargo generate-lockfile
fi
cargo fmt --all -- --check
cargo build --locked --release

printf '%s\n' "$(getconf GNU_LIBC_VERSION)" \
    "GTK $(pkg-config --modversion gtk+-3.0)" "VTE $(pkg-config --modversion vte-2.91)"
test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.28"
pkg-config --exact-version=3.22.30 gtk+-3.0
pkg-config --exact-version=0.52.4 vte-2.91

binary=target/release/ssh-workbench
required_glibc="$(readelf --version-info "$binary" | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' | sort -Vu | tail -n 1)"
printf 'Highest glibc symbol required: %s\n' "$required_glibc"
test "$(printf '%s\n' "$required_glibc" GLIBC_2.28 | sort -V | tail -n 1)" = GLIBC_2.28
dependencies="$(readelf --dynamic "$binary")"
grep -Fq '[libgtk-3.so.0]' <<< "$dependencies"
grep -Fq '[libvte-2.91.so.0]' <<< "$dependencies"

desktop-file-validate packaging/io.github.zyw02.SshWorkbench.desktop
version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' Cargo.toml)"
topdir="$(mktemp -d)"
rpmbuild -bb \
    --define "_topdir $topdir" \
    --define "_sourcedir $PWD" \
    --define "workbench_version $version" \
    packaging/ssh-workbench.spec

mkdir -p dist
cp "$topdir"/RPMS/x86_64/*.rpm dist/
package=(dist/*.rpm)
rpm -qp --requires "${package[0]}"
rpm -Uvh "${package[0]}"
dbus-run-session -- bash packaging/smoke-test.sh /usr/bin/ssh-workbench
