%global debug_package %{nil}
%global _build_id_links none
%global __os_install_post %{nil}
%global __provides_exclude_from ^%{_libexecdir}/span-web-preview/.*
%global __requires_exclude ^lib(ffmpeg|EGL|GLESv2|vk_swiftshader)[.]so.*

Name:           span-web-preview
Version:        0.1.0
Release:        0.1.preview%{?dist}
Summary:        Span Web Workbench preview
License:        MIT and BSD and LGPL
URL:            https://github.com/vellinlab/span
Requires:       gtk3
Requires:       mesa-libgbm
Requires:       openssh-clients

%description
Preview of the Span Web Workbench with an embedded terminal and Agent sessions.

%install
runtime=%{buildroot}%{_libexecdir}/span-web-preview
install -d -m 0755 "$runtime" %{buildroot}%{_bindir}
cp -a %{preview_runtime}/. "$runtime/"
chmod 4755 "$runtime/chrome-sandbox"
ln -s %{_libexecdir}/span-web-preview/span-preview %{buildroot}%{_bindir}/span-web-preview

install -d -m 0755 %{buildroot}%{_datadir}/applications
cat > %{buildroot}%{_datadir}/applications/io.github.vellinlab.SpanWebPreview.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Span Web Preview
Exec=span-web-preview
Icon=io.github.vellinlab.SpanWebPreview
Terminal=false
Categories=Development;System;
DESKTOP
install -Dpm 0644 "$runtime/resources/app/dist/span.svg" \
    %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/io.github.vellinlab.SpanWebPreview.svg

%files
%defattr(-,root,root,-)
%{_bindir}/span-web-preview
%{_libexecdir}/span-web-preview
%{_datadir}/applications/io.github.vellinlab.SpanWebPreview.desktop
%{_datadir}/icons/hicolor/scalable/apps/io.github.vellinlab.SpanWebPreview.svg
