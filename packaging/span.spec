%global debug_package %{nil}
%global __provides_exclude_from ^%{_libdir}/span/.*
%global __requires_exclude ^libvte-2[.]91[.]so[.]0.*

Name:           span
Version:        %{span_version}
Release:        1%{?dist}
Summary:        Span SSH terminal and Codex workspace
License:        Unspecified and LGPL-3.0-or-later
URL:            https://github.com/vellinlab/span
Requires:       bash
Requires:       coreutils
Requires:       openssh-clients
Requires:       gtk3 >= 3.22.30
Requires:       librsvg2
Recommends:     xorg-x11-xauth
Provides:       ssh-workbench
Obsoletes:      ssh-workbench < 0.6.4

%description
Open local shells and OpenSSH sessions in a tabbed GTK workspace.

%install
install -Dpm 0755 %{_sourcedir}/target/release/span %{buildroot}%{_libexecdir}/span
install -dm 0755 %{buildroot}%{_bindir}
cat > %{buildroot}%{_bindir}/span <<'LAUNCHER'
#!/bin/sh
# Old GLib reads its allocation policy before the application enters main.
if [ "${G_SLICE+x}" != x ]; then
    export G_SLICE=always-malloc SPAN_INTERNAL_G_SLICE=1
else
    unset SPAN_INTERNAL_G_SLICE
fi
exec %{_libexecdir}/span "$@"
LAUNCHER
chmod 0755 %{buildroot}%{_bindir}/span
ln -s span %{buildroot}%{_bindir}/ssh-workbench
install -Dpm 0644 %{_sourcedir}/packaging/io.github.zyw02.SshWorkbench.desktop %{buildroot}%{_datadir}/applications/io.github.zyw02.SshWorkbench.desktop
install -dm 0755 %{buildroot}%{_datadir}/icons
cp -a %{_sourcedir}/packaging/icons/hicolor %{buildroot}%{_datadir}/icons/

install -Dpm 0755 %{_sourcedir}/target/bundled-vte/libvte-2.91.so.0 %{buildroot}%{_libdir}/span/libvte-2.91.so.0
install -Dpm 0644 %{_sourcedir}/target/bundled-vte/SOURCE %{buildroot}%{_docdir}/span/VTE-SOURCE
install -dm 0755 %{buildroot}%{_licensedir}/span
install -pm 0644 %{_sourcedir}/target/bundled-vte/COPYING.* %{buildroot}%{_licensedir}/span/

%files
%dir %{_libdir}/span
%{_libdir}/span/libvte-2.91.so.0
%doc %{_docdir}/span/VTE-SOURCE
%license %{_licensedir}/span/COPYING.*
%{_bindir}/span
%{_libexecdir}/span
%{_bindir}/ssh-workbench
%{_datadir}/applications/io.github.zyw02.SshWorkbench.desktop
%{_datadir}/icons/hicolor/scalable/apps/io.github.zyw02.SshWorkbench.svg
