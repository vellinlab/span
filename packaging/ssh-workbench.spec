%global debug_package %{nil}

Name:           ssh-workbench
Version:        %{workbench_version}
Release:        1%{?dist}
Summary:        A desktop terminal for local shells and OpenSSH sessions
License:        Unspecified
URL:            https://github.com/zyw02/ssh-workbench
Requires:       bash
Requires:       openssh-clients
Requires:       gtk3 >= 3.22.30
Requires:       vte291 >= 0.52.4
Recommends:     xorg-x11-xauth

%description
Open a local Bash shell and a remote OpenSSH session in a split GTK window.

%install
install -Dpm 0755 %{_sourcedir}/target/release/ssh-workbench %{buildroot}%{_bindir}/ssh-workbench
install -Dpm 0644 %{_sourcedir}/packaging/io.github.zyw02.SshWorkbench.desktop %{buildroot}%{_datadir}/applications/io.github.zyw02.SshWorkbench.desktop

%files
%{_bindir}/ssh-workbench
%{_datadir}/applications/io.github.zyw02.SshWorkbench.desktop
