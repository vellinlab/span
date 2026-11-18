# Span

<img src="packaging/icons/hicolor/128x128/apps/io.github.zyw02.SshWorkbench.png" width="72" height="72" alt="Span 图标">

用 Rust、GTK3 和 VTE 构建的 Linux SSH 终端和 Codex 工作台。左侧管理 SSH 主机，顶部标签在本地 Bash 和远程会话间切换。

## 安装

### NewStartOS／EL8 x86_64

在 GitHub Actions 的 **Build Linux** 成功运行页面下载 `ssh-workbench-el8-x86_64`，解压后安装 RPM。

```sh
sudo dnf install ./ssh-workbench-0.6.1-1.el8.x86_64.rpm
ssh-workbench
```

CI 使用 AlmaLinux 8，验证 glibc 2.28 和 GTK 3.22.30，并在虚拟 X11 下启动已安装的 RPM。RPM 带有仅由 Workbench 加载的 VTE 0.64.2。该版本能忽略 Codex 的 OSC 状态序列。对应的 VTE 源码可从同一次构建的 `vte-0.64.2-source` 取得。

### Ubuntu 24.04 amd64

下载同一构建页面的 `ssh-workbench-linux-amd64` 并解压。

```sh
sudo apt install ./ssh-workbench_0.6.1_amd64.deb
ssh-workbench
```

Span 使用 `ssh-workbench` 包名和启动命令，可直接升级此前的 SSH Workbench 安装。日常发布沿用 `0.6.x`，递增第三段版本号。

## 使用

- 启动后进入本地 Bash。标签栏的「+」打开另一个本地终端，标签可拖动排序。
- 主机栏的「+」添加配置，点击主机打开 SSH 标签，「…」菜单提供编辑和删除。配置保存在 `$XDG_CONFIG_HOME/ssh-workbench/hosts.ini`，通常是 `~/.config/ssh-workbench/hosts.ini`。
- 「会话 → 快速连接」适合临时连接。SSH 目标可填 OpenSSH 别名或 `user@host`。系统 OpenSSH 读取现有配置、代理和认证设置。
- 为可信主机开启「信任 X11 转发」后，应用使用 `ssh -Y` 和当前标签的专用控制套接字。连接后在远端 Codex 中按 `Ctrl+V` 附上本机截图。
- 文字复制和粘贴使用 `Ctrl+Shift+C` 和 `Ctrl+Shift+V`。用 `Ctrl+Shift+T` 新建本地标签，`Ctrl+Shift+W` 关闭当前标签。

## 文件目录

点击标签栏右侧的文件夹，或按 `Ctrl+Shift+F` 打开右栏。面板根据当前终端标签显示本地目录或远端目录，可输入路径、双击进入子目录、返回上一级、刷新和显示隐藏项。每个标签单独记住当前目录。

远端列表通过已登录的 OpenSSH 连接打开 SFTP 通道。首次显示远端登录目录。面板支持浏览和查看元数据。服务器需要启用 SFTP，并允许一个 SSH 连接同时打开 Shell 和 SFTP 通道。

## Codex 会话

点击当前终端标签右侧的「Codex」，或按 `Ctrl+Shift+A`，在同一标签内切换终端与 Agent 界面。

- 「会话」（`Ctrl+Shift+H`）按工作目录展示当前主机保存的会话，支持搜索、查看归档和新建。打开旧会话后，可以按需加载更早的对话，也可以直接填会话 ID。SSH 断开后，在同一标签重新连接会恢复上次打开的已保存会话。
- 「终端」（`Ctrl+Shift+J`）在会话页下方展开当前标签的真实终端。「加入选区」把终端中选中的文字放进输入框，供编辑后发送。
- Codex 的问题和审批显示为可操作卡片。文件变更可按轮次展开查看只读 diff。

运行 Agent 的主机需要安装支持 App Server 的 Codex CLI，并完成其正常登录。如果使用 SSH，先在终端完成登录。会话通过同一条已认证的 SSH 连接启动 App Server，并使用所选工作目录。

Agent 回复支持 GitHub 风格 Markdown 表格、Mermaid 基础流程图和时序图，以及本机或远端文件中的 PNG/JPEG 图片。表格可以单独复制为 HTML 富文本、CSV 或 Markdown。图片和 Mermaid 图可以放大、复制和保存，Mermaid 图同时提供源码。复杂 Mermaid 语法以源码显示，图片文件预览上限为 8 MiB。
