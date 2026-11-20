# Span

<img src="packaging/icons/hicolor/scalable/apps/io.github.zyw02.SshWorkbench.svg" width="72" height="72" alt="Span 图标">

用 Rust 和 GTK3 构建的 SSH 终端和 Codex 工作台。左侧管理 SSH 主机，顶部标签在本地终端和远程会话间切换。

## 安装

### NewStartOS／EL8 x86_64

从 [GitHub Releases](https://github.com/vellinlab/span/releases) 直接下载 `.rpm` 文件并安装。

```sh
sudo dnf install ./span-0.1.0-rc.18-1.el8.x86_64.rpm
span
```

CI 使用 AlmaLinux 8，验证 glibc 2.28 和 GTK 3.22.30，并在虚拟 X11 下启动已安装的 RPM。RPM 带有仅由 Span 加载的 VTE 0.64.2。该版本能忽略 Codex 的 OSC 状态序列。对应源码 `vte-0.64.2.tar.xz` 随 Release 提供。

### Ubuntu 24.04 amd64

从同一个 Release 下载 `.deb` 文件。

```sh
sudo apt install ./span_0.1.0-rc.18_amd64.deb
span
```

安装包与启动命令均使用 `span`。安装时会替换旧的 `ssh-workbench` 软件包，继续读取已有的主机配置。`ssh-workbench` 启动命令仍可作为兼容别名使用。

### Windows x86_64

下载 `span-*-windows-x86_64.zip`。版本包随 GitHub Release 发布，测试包可在通过的 [Build Windows](https://github.com/vellinlab/span/actions/workflows/windows.yml) 中下载。解压后打开 `Span.exe`，使用 Windows 自带的 ConPTY 运行 PowerShell。GTK3 运行库随便携包提供。

远程终端使用系统 OpenSSH 客户端，密码和验证码在终端中输入。Windows 的 SFTP 和远程 Codex 会为同一主机建立后台 SSH 连接，需要可直接使用的密钥或 SSH Agent。先在终端确认主机公钥，后台连接会验证已保存的主机身份。使用本地 Codex 会话需要将已登录的 `codex.exe` 放在 `PATH` 中。本地 Windows Codex 目前使用独立的 App Server。

带 `-alpha.N`、`-beta.N` 或 `-rc.N` 后缀的版本会标记为预发布，供测试使用。

界面英文字体优先使用本机的 Segoe UI，简体中文优先使用微软雅黑 UI 或微软雅黑。NewStartOS／EL8 的 RPM 使用系统已有字体。DEB 包附带微软的 [Selawik 1.01](https://github.com/microsoft/Selawik/releases/tag/1.01)，供缺少 Segoe UI 的系统使用。缺少微软雅黑时，优先使用系统已有的思源黑体或 Noto Sans CJK SC。

## 使用

- 启动后进入本地终端。Linux 默认使用 Bash，Windows 默认使用 PowerShell。标签栏的「+」打开另一个本地终端，标签可拖动排序。
- 主机栏的「+」添加配置，点击主机打开 SSH 标签，「…」菜单提供编辑和删除。配置保存在 `$XDG_CONFIG_HOME/ssh-workbench/hosts.ini`，通常是 `~/.config/ssh-workbench/hosts.ini`。
- 全新安装的主机列表为空。可以用「主机 → 导入 SSH 配置」勾选本机 `~/.ssh/config` 和它引用的配置文件中的主机别名。仅保存选中的别名，已有条目的名称和 X11 设置会保留。
- 「会话 → 快速连接」适合临时连接。SSH 目标可填 OpenSSH 别名或 `user@host`。系统 OpenSSH 读取现有配置、代理和认证设置。
- Linux 下，为可信主机开启「信任 X11 转发」后，应用使用 `ssh -Y` 和当前标签的专用控制套接字。连接后在远端 Codex 中按 `Ctrl+V` 附上本机截图。
- 文字复制和粘贴使用 `Ctrl+Shift+C` 和 `Ctrl+Shift+V`。用 `Ctrl+Shift+T` 新建本地标签，`Ctrl+Shift+W` 关闭当前标签。

## 文件目录

在左栏切换「主机」「会话」「文件」，或按 `Ctrl+Shift+F` 打开文件页。文件页根据当前终端标签显示本地或远端目录，可输入路径、双击进入子目录、返回上一级、刷新和显示隐藏项。每个标签单独记住当前目录。

可拖动左栏右边的分隔线调整宽度。快速连接先填写 SSH 目标，由 OpenSSH 请求认证。支持 AskPass 的 OpenSSH 在需要时弹出掩码输入框，较早的客户端在终端中提示。密码与验证码不会保存。

双击文件可在右侧预览 UTF-8 文本、代码、Markdown、HTML、Mermaid 和 PNG/JPEG/SVG 图片。图片可缩放、适合宽度或恢复原始大小，也可用 `Ctrl`＋滚轮缩放。SVG 和 Mermaid 按当前倍率重绘。Markdown 预览保留代码块与表格，HTML 以静态方式展示。上方按钮可上传本机文件到当前目录，或下载选中的文件。上传遇到同名文件时会提示，下载覆盖前会确认。Linux 的远端文件操作复用已登录的 OpenSSH 连接，Windows 按上述要求建立后台 SFTP 连接。

Codex 回复中生成的图片、Mermaid、HTML 和可识别的文件链接会自动进入同一个右侧预览区。用预览标题栏的箭头切换产物，点击会话里的文件链接或预览按钮可再次打开。HTML 预览中的 HTTP／HTTPS 链接由系统默认浏览器打开。手动选中的预览会保留，新的产物可用箭头切换查看。

## Codex 会话

点击窗口顶部右侧的对话图标，或按 `Ctrl+Shift+A`，在同一标签内切换终端与 Agent 界面。

- 左栏的「主机」和「会话」页签用于切换连接列表和 Codex 会话。通过「会话」（`Ctrl+Shift+H`）按工作目录浏览当前标签所在主机的会话，支持搜索、归档筛选和新建。打开旧会话后可以加载更早的对话。SSH 断开后，在同一标签重新连接会恢复上次打开的已保存会话。
- 会话页右上角的终端面板图标（`Ctrl+Shift+J`）在下方展开当前标签的真实终端。「加入选区」把终端中选中的文字放进输入框，供编辑后发送。
- 底部终端右上角的「+」在面板中新开一个终端。SSH 标签使用当前主机和已认证的连接，下拉框切换终端，「×」关闭当前新增的终端。
- 每轮的活动区展示 Codex 提供的推理摘要、命令、代码搜索、网页搜索和文件变更。运行中可以展开查看命令输出或带行号的实时 diff，并复制原始补丁。Codex 的问题和审批以可操作卡片呈现。
- 输入区可以选择当前主机提供的模型和思考强度。点亮闪电使用 Fast，关闭恢复标准速度，设置从下一条消息起生效。Fast 需要支持该模式的模型及 Codex CLI 0.151 或更新版本。任务运行时，输入区上方显示进度和用时，按 `Esc` 可中断。悬停或点击输入区右侧的两个环，分别查看套餐剩余额度和上下文占用。
- 输入框底部的盾牌按钮可切换「工作区权限」「只读」「完全访问」。新会话默认采用工作区权限，打开已有会话时沿用 Codex 返回的权限。完全访问需要确认，选择从下一轮起生效。
- 在会话输入框按 `Enter` 发送，按 `Shift+Enter` 换行。`Ctrl+Enter` 也可发送。任务运行时输入新内容再按 `Enter`，可将消息追加到当前任务，同时可用方块按钮或 `Esc` 中断。
- 推理摘要、生成中的回复和已完成的回复支持 Markdown 加粗与可点击的 HTTP／HTTPS 链接。每轮完成后，末尾的两个图标分别复制该轮的 Markdown 和富文本。
- 鼠标选中回复、推理摘要或文件预览中的文字后，点击「引用」把选区加入输入框上方的引用卡片。每条可单独移除，发送时与正文一同交给 Codex。
- 点击「附件」选择本机文件，或在输入框按 `Ctrl+V` 粘贴剪贴板图片。发送前可移除，每条消息最多 6 个、合计 16 MiB。SSH 会话通过当前连接的 SFTP 将附件放入远端私有临时目录。支持视觉输入的模型会直接收到 PNG、JPEG、GIF 和 WebP 图片，其余附件按文件路径交给 Agent 读取。

运行 Agent 的主机需要安装支持 App Server 的 Codex CLI，并完成登录。如果使用 SSH，先在终端完成登录。Span 会通过已认证的 SSH 连接访问该主机上的 Codex，并使用所选工作目录。

使用 ChatGPT App 接续时，先在运行 Codex 的主机上配置并启动 Codex 远程控制，再在 Span 中打开会话。Span 会自动接入同一用户、同一 `CODEX_HOME` 下正在运行的共享后台，保留原会话 ID，接收其他客户端的会话更新。关闭 Span 标签只会断开该标签的连接。未运行共享后台时，Span 使用独立的 App Server，可在关闭该会话标签后从其他客户端接续。

Agent 回复支持可滚动和复制的 Markdown 代码卡片、GitHub 风格表格、Mermaid 基础流程图和时序图，以及本机或远端文件中的 PNG/JPEG 图片。正文和表格可跨段落或单元格拖选，按 `Ctrl+C` 复制。表格也可以单独复制为 HTML 富文本、CSV 或 Markdown。图片和 Mermaid 图可以放大、复制和保存，Mermaid 图同时提供源码。复杂 Mermaid 语法以源码显示，图片文件预览上限为 8 MiB。
