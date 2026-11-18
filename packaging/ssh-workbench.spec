%global debug_package %{nil}
%global __provides_exclude_from ^%{_libdir}/ssh-workbench/.*
%global __requires_exclude ^libvte-2[.]91[.]so[.]0.*

Name:           ssh-workbench
Version:        %{workbench_version}
Release:        1%{?dist}
Summary:        A desktop terminal for local shells and OpenSSH sessions
License:        Unspecified and LGPL-3.0-or-later
URL:            https://github.com/zyw02/ssh-workbench
Requires:       bash
Requires:       coreutils
Requires:       openssh-clients
Requires:       gtk3 >= 3.22.30
Recommends:     xorg-x11-xauth

%description
Open local shells and OpenSSH sessions in a tabbed GTK workspace.

%install
install -Dpm 0755 %{_sourcedir}/target/release/ssh-workbench %{buildroot}%{_bindir}/ssh-workbench
install -Dpm 0644 %{_sourcedir}/packaging/io.github.zyw02.SshWorkbench.desktop %{buildroot}%{_datadir}/applications/io.github.zyw02.SshWorkbench.desktop

install -Dpm 0755 %{_sourcedir}/target/bundled-vte/libvte-2.91.so.0 %{buildroot}%{_libdir}/ssh-workbench/libvte-2.91.so.0
install -Dpm 0644 %{_sourcedir}/target/bundled-vte/SOURCE %{buildroot}%{_docdir}/ssh-workbench/VTE-SOURCE
install -dm 0755 %{buildroot}%{_licensedir}/ssh-workbench
install -pm 0644 %{_sourcedir}/target/bundled-vte/COPYING.* %{buildroot}%{_licensedir}/ssh-workbench/

%files
%dir %{_libdir}/ssh-workbench
%{_libdir}/ssh-workbench/libvte-2.91.so.0
%doc %{_docdir}/ssh-workbench/VTE-SOURCE
%license %{_licensedir}/ssh-workbench/COPYING.*
%{_bindir}/ssh-workbench
%{_datadir}/applications/io.github.zyw02.SshWorkbench.desktop
