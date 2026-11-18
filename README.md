# SSH Workbench

用于 Linux 桌面的轻量双窗格终端。使用 Rust、GTK4/VTE 和系统 OpenSSH。

## 安装

在 GitHub Actions 的 **Build Linux** 成功运行页面下载 `ssh-workbench-linux-amd64`，解压后在 Ubuntu 24.04 x86-64 上安装其中的 Debian 软件包。

```sh
sudo apt install ./ssh-workbench_0.1.0_amd64.deb
ssh-workbench
```

在 NDE 的 X11 会话里，可以用 Cairo 软件渲染启动：

```sh
GDK_BACKEND=x11 GSK_RENDERER=cairo ssh-workbench
```

## 使用

左侧是本地 Bash。右侧默认填了 `tokyo`，可以改成你在 OpenSSH 中使用的主机别名或 `user@host`。按「连接」后，系统 SSH 会照常处理你的配置、代理和认证。

远程 Codex 需要通过 X11 读取本机截图时，先勾选「信任 X11」再连接。此选项使用 `ssh -Y -S none`，允许远端程序访问本机 X11 会话，请只对信任的主机使用。连接后，和在普通终端里一样，用 `Ctrl+V` 将截图附到 Codex。文字复制和粘贴用 `Ctrl+Shift+C` 和 `Ctrl+Shift+V`。

## 本地构建

```sh
sudo apt-get install build-essential pkg-config libgtk-4-dev libvte-2.91-gtk4-dev
cargo build --locked --release
```
