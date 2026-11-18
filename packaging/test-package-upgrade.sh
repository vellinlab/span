#!/usr/bin/env bash
set -euo pipefail

package="$(realpath "$1")"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT

case "$package" in
    *.deb)
        mkdir -p "$fixture/package/DEBIAN" "$fixture/package/usr/bin"
        cat > "$fixture/package/DEBIAN/control" <<'CONTROL'
Package: ssh-workbench
Version: 0.6.3
Architecture: amd64
Maintainer: Span CI <zyw02@users.noreply.github.com>
Description: Fixture for the previously installed SSH Workbench package
CONTROL
        touch "$fixture/package/usr/bin/ssh-workbench"
        dpkg-deb --root-owner-group --build "$fixture/package" "$fixture/legacy.deb" >/dev/null
        sudo dpkg -i "$fixture/legacy.deb"
        sudo apt-get install -y --no-install-recommends "$package"
        test "$(dpkg-query -W -f='${Status}' span)" = 'install ok installed'
        ! dpkg-query -W -f='${Status}\n' ssh-workbench 2>/dev/null | grep -qx 'install ok installed'
        ;;
    *.rpm)
        cat > "$fixture/legacy.spec" <<'SPEC'
%global debug_package %{nil}
Name: ssh-workbench
Version: 0.6.3
Release: 1.el8
Summary: Fixture for the previously installed SSH Workbench package
License: Unspecified
BuildArch: noarch

%description
Legacy package used to test upgrading to Span.

%install
mkdir -p %{buildroot}%{_bindir}
touch %{buildroot}%{_bindir}/ssh-workbench

%files
%{_bindir}/ssh-workbench
SPEC
        rpmbuild -bb --define "_topdir $fixture" "$fixture/legacy.spec" >/dev/null
        rpm -i "$fixture/RPMS/noarch/ssh-workbench-0.6.3-1.el8.noarch.rpm"
        dnf -y --disablerepo='*' install "$package"
        rpm -q span
        ! rpm -q ssh-workbench
        ;;
    *) exit 2 ;;
esac

test -x /usr/bin/span
test "$(readlink /usr/bin/ssh-workbench)" = span
printf '%s\n' 'Span replaced the legacy SSH Workbench package and retained the old launcher alias.'
