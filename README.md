# SSH Workbench

一个 Linux 双窗格终端。左侧运行本地 Bash，右侧通过系统 OpenSSH 连接远端。应用使用 Rust 和 GTK3/VTE，支持 X11 桌面。

## 安装

### NewStartOS／EL8 x86_64

在 GitHub Actions 的 **Build Linux** 成功运行页面下载 `ssh-workbench-el8-x86_64`，解压后安装 RPM。

```sh
sudo dnf install ./ssh-workbench-0.2.1-1.el8.x86_64.rpm
ssh-workbench
```

CI 使用 AlmaLinux 8，验证 glibc 2.28 和 GTK 3.22.30，并在虚拟 X11 下启动已安装的 RPM。RPM 带有仅由 Workbench 加载的 VTE 0.64.2。该版本能忽略 Codex 的 OSC 状态序列。对应的 VTE 源码可从同一次构建的 `vte-0.64.2-source` 取得。

### Ubuntu 24.04 amd64

下载同一构建页面的 `ssh-workbench-linux-amd64` 并解压。

```sh
sudo apt install ./ssh-workbench_0.2.1_amd64.deb
ssh-workbench
```

## 使用

右侧默认填入 `tokyo`。可以改成 OpenSSH 配置中的主机别名或 `user@host`。按「连接」后，系统 SSH 会使用现有配置、代理和认证。

如果远端 Codex 需要通过 X11 读取本机截图，先勾选「信任 X11」再连接。此选项使用 `ssh -Y -S none`，允许远端程序访问本机 X11 会话，请只对信任的主机使用。连接后在 Codex 中按 `Ctrl+V` 附上截图。文字复制和粘贴分别使用 `Ctrl+Shift+C` 和 `Ctrl+Shift+V`。
