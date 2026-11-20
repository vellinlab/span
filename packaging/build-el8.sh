#!/usr/bin/env bash
set -euo pipefail

dnf --enablerepo=powertools --setopt=install_weak_deps=False -y install \
    gcc binutils ca-certificates curl pkgconf-pkg-config rpm-build desktop-file-utils \
    gtk3-devel vte291-devel librsvg2-devel openssh-clients dbus-daemon xorg-x11-server-Xvfb xorg-x11-utils \
    gcc-c++ gettext meson ninja-build python39 fribidi-devel gnutls-devel pcre2-devel zlib-devel xz

curl -fsSL --retry 3 https://sh.rustup.rs -o /tmp/span-rustup.sh
bash /tmp/span-rustup.sh -y --profile minimal --default-toolchain 1.98.1 --component rustfmt
export PATH="$HOME/.cargo/bin:$PATH"

cargo fmt --all -- --check
export RUSTFLAGS='-C link-arg=-Wl,-rpath,$ORIGIN/../lib64/span'
cargo build --locked --release
cargo test --locked --release svg::tests
bash packaging/build-vte-el8.sh
gcc -o target/verify-osc packaging/verify-osc.c $(pkg-config --cflags --libs gtk+-3.0 vte-2.91)

printf '%s\n' "$(getconf GNU_LIBC_VERSION)" \
    "GTK $(pkg-config --modversion gtk+-3.0)" "VTE $(pkg-config --modversion vte-2.91)"
test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.28"
pkg-config --exact-version=3.22.30 gtk+-3.0
pkg-config --exact-version=0.52.4 vte-2.91

binary=target/release/span
required_glibc="$(readelf --version-info "$binary" target/bundled-vte/libvte-2.91.so.0 | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' | sort -Vu | tail -n 1)"
printf 'Highest glibc symbol required: %s\n' "$required_glibc"
test "$(printf '%s\n' "$required_glibc" GLIBC_2.28 | sort -V | tail -n 1)" = GLIBC_2.28
dependencies="$(readelf --dynamic "$binary")"
grep -Fq '[libgtk-3.so.0]' <<< "$dependencies"
grep -Fq '[libvte-2.91.so.0]' <<< "$dependencies"
grep -Fq '[librsvg-2.so.2]' <<< "$dependencies"

desktop-file-validate packaging/io.github.zyw02.SshWorkbench.desktop
version="$(bash packaging/package-version.sh)"
topdir="$(mktemp -d)"
rpmbuild -bb \
    --define "_topdir $topdir" \
    --define "_sourcedir $PWD" \
    --define "span_version $version" \
    packaging/span.spec

mkdir -p dist
cp "$topdir"/RPMS/x86_64/*.rpm dist/
package=(dist/span-*.rpm)
rpm -qp --requires "${package[0]}"
bash packaging/test-package-upgrade.sh "${package[0]}" "$@"
linked_vte="$(ldd /usr/bin/span | awk '$1 == "libvte-2.91.so.0" { print $3 }')"
test "$(realpath "$linked_vte")" = /usr/lib64/span/libvte-2.91.so.0
dbus-run-session -- bash packaging/smoke-test.sh /usr/bin/span target/verify-osc

# Exercise the two actual RPM executables against the target GTK and bundled VTE.
if [[ -n ${SPAN_BENCH_RPM:-} ]]; then
    dnf -y install epel-release
    dnf --enablerepo=powertools --setopt=install_weak_deps=False -y install \
        xdotool google-noto-sans-cjk-ttc-fonts cpio python39-pip
    bench="$(mktemp -d)"
    python3.9 -m pip install --disable-pip-version-check --target "$bench/python" python-xlib==0.33
    baseline_name="${SPAN_BENCH_RPM##*/}"
    baseline_version="${baseline_name#span-}"
    baseline_version="${baseline_version%-1.el8.x86_64.rpm}"
    mkdir -p "$bench/previous" "$bench/$baseline_version" "$bench/candidate"
    (cd "$bench/previous" && rpm2cpio "$SPAN_BENCH_RPM" | cpio -id --quiet)
    ln -s "$bench/previous/usr/bin/span" "$bench/$baseline_version/span"
    ln -s /usr/bin/span "$bench/candidate/span"
    # The fixture uses the same Python as the benchmark on both launches.
    ln -s /usr/bin/python3.9 "$bench/python/python3"
    Xvfb :92 -screen 0 1600x980x24 -nolisten tcp &
    display_pid=$!
    trap 'kill "$display_pid" 2>/dev/null || true' EXIT
    export DISPLAY=:92
    for attempt in {1..100}; do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done
    PATH="$bench/python:$PATH" PYTHONPATH="$bench/python" dbus-run-session -- python3.9 packaging/bench-interaction.py \
        "$bench/$baseline_version/span" "$bench/candidate/span" "$bench/candidate/span" "$bench/$baseline_version/span"
fi
