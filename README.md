# SSH Workbench

用 Rust、GTK3 和 VTE 构建的 Linux 桌面终端。左侧管理 SSH 主机，顶部标签在本地 Bash 和远程会话间切换。

## 安装

### NewStartOS／EL8 x86_64

在 GitHub Actions 的 **Build Linux** 成功运行页面下载 `ssh-workbench-el8-x86_64`，解压后安装 RPM。

```sh
sudo dnf install ./ssh-workbench-0.4.0-1.el8.x86_64.rpm
ssh-workbench
```

CI 使用 AlmaLinux 8，验证 glibc 2.28 和 GTK 3.22.30，并在虚拟 X11 下启动已安装的 RPM。RPM 带有仅由 Workbench 加载的 VTE 0.64.2。该版本能忽略 Codex 的 OSC 状态序列。对应的 VTE 源码可从同一次构建的 `vte-0.64.2-source` 取得。

### Ubuntu 24.04 amd64

下载同一构建页面的 `ssh-workbench-linux-amd64` 并解压。

```sh
sudo apt install ./ssh-workbench_0.4.0_amd64.deb
ssh-workbench
```

## 使用

- 启动后进入本地 Bash。标签栏的「+」打开另一个本地终端，标签可拖动排序。
- 主机栏的「+」添加配置，点击主机打开 SSH 标签，「…」菜单提供编辑和删除。配置保存在 `$XDG_CONFIG_HOME/ssh-workbench/hosts.ini`，通常是 `~/.config/ssh-workbench/hosts.ini`。
- 「会话 → 快速连接」适合临时连接。SSH 目标可填 OpenSSH 别名或 `user@host`。系统 OpenSSH 读取现有配置、代理和认证设置。
- 为可信主机开启「信任 X11 转发」后，应用使用 `ssh -Y` 和当前标签的专用控制套接字。连接后在远端 Codex 中按 `Ctrl+V` 附上本机截图。
- 文字复制和粘贴使用 `Ctrl+Shift+C` 和 `Ctrl+Shift+V`。用 `Ctrl+Shift+T` 新建本地标签，`Ctrl+Shift+W` 关闭当前标签。

## 文件目录

点击标签栏右侧的文件夹，或按 `Ctrl+Shift+F` 打开右栏。面板根据当前终端标签显示本地目录或远端目录，可输入路径、双击进入子目录、返回上一级、刷新和显示隐藏项。每个标签单独记住当前目录。

远端列表通过已登录的 OpenSSH 连接打开 SFTP 通道。首次显示远端登录目录。面板支持浏览和查看元数据。服务器需要启用 SFTP，并允许一个 SSH 连接同时打开 Shell 和 SFTP 通道。
