# Span Electron 工作台

持续评审的优先级、验收场景和复验方法见[Electron 评审细则](REVIEW.md)。

## Codex 连接

本机和 SSH 都先探测 `CODEX_HOME/app-server-control/app-server-control.sock`。找到端点后，Span 通过 `codex app-server proxy` 建立 WebSocket。端点缺失或代理握手失败时，使用独立的 JSONL App Server。只开放父子进程管道的 ChatGPT 实例无法接受外部客户端连接。把指针移到输入区的连接控件上可以查看实际使用的连接。 [Codex App Server 协议](https://learn.chatgpt.com/docs/app-server)

Windows 本机依次尝试 `SPAN_CODEX_PATH`、`CODEX_CLI_PATH`、PATH、Codex 管理目录、用户安装和运行缓存，以及当前用户注册的 ChatGPT/Codex AppX 的 `resources` 目录。如果 Windows 拒绝执行 AppX 内的文件，可以把 `SPAN_CODEX_PATH` 指向可执行的用户安装版。 [Codex 独立安装与 daemon 文档](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)

## Agent 适配协议

`ui/agent-protocol.d.ts` 定义会话标识、历史分页、交互和事件。会话标识由后端、本机或 SSH 位置和后端原始 ID 组成。适配器负责协议转换、进程及其会话存储，并把历史记录和实时事件都转换成同一种会话条目。

| 后端 | 适配方式与能力 |
| --- | --- |
| Codex | 已注册。本机或 SSH 接入 App Server。使用原生目标、用量、规划、审批、模型和速度档位。可以在父会话查看已保存的子代理记录，也可以打开子会话继续交流。 |
| Clue | 已注册。本机或 SSH 使用现有的 `clue app-server` 兼容路径。使用基础会话和回合操作。 |
| Claude Code | 本机和 SSH 通过 Claude Agent SDK 的 ACP 适配器。使用 Claude 原生会话，接收流式推理、回复、工具活动、审批和用量。支持子代理会话记录和审批归属。适配器公开 Goal 时，可以设置、替换和清除目标。 |
| Pi Agent | 已注册。本机和 SSH 启动 `pi --mode rpc`，使用 Pi 自己保存的会话。支持模型和思考级别、`steer`、`follow_up`、会话统计、扩展命令及交互。 |
| OpenCode | 本机和 SSH 通过 ACP 连接 `opencode acp`。使用 OpenCode 保存的会话，支持流式回复和推理、工具活动、审批、停止、用量，以及当前会话公开的模型和模式。 |
| Kilo | 本机和 SSH 通过 ACP 连接 `kilo acp`。与 OpenCode 共用协议和界面，模型、模式与会话从 Kilo 原生进程读取。支持原生 Goal 的版本在输入框上方显示目标，可启动、暂停、继续并查看结果。 |

[Claude Code Agent SDK](https://code.claude.com/docs/en/headless) · [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) · [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)

接入后端时，在 `ui/agent.js` 注册适配器工厂。使用本地或 SSH 进程的适配器在 Rust 服务中声明启动方式。实现会话和回合的基础操作，按能力提供可选操作。界面按能力显示控件，并消费统一事件。后端专属操作使用带命名空间的命令和事件。

Pi 可以使用 PATH 中的 CLI。本机也可用 `SPAN_PI_PATH` 指定可执行文件。工作台读取 Pi 为当前工作区返回的会话目录，通过 Pi RPC 恢复会话，并显示当前历史分支。扩展注册的命令可从斜杠菜单发送给 Pi。 [Pi RPC 协议](https://github.com/earendil-works/pi/blob/v1.6.0/packages/coding-agent/docs/rpc.md)

安装 Pi Teams 扩展后，可以在本机或 SSH 会话用 `/agents` 查看当前主会话的团队、成员、负责人和任务依赖。面板打开时刷新活动团队，从 Pi Teams 保存的状态确认任务是否受阻。团队的创建、分配和停用通过 Pi Teams 原生命令和工具执行。重开面板时会读取仍存在的任务板，团队数据保留周期由扩展管理。 [Pi Teams 工作流](https://github.com/vadimcomanescu/pi-teams#team-first-workflow)

点击成员名可查看该成员已保存的任务、推理、工具和答复。打开时从日志尾部找出当前分支，先读取最近 20 轮。向上滚动才请求更早的页。本机和 SSH 都按块读取 Pi Teams 默认会话目录里的文件，单条记录和单页各有 16 MiB 的上限。

Codex 和 Pi 在 Agent 菜单中提供「技能」。在输入框用 `/skills` 也可以打开面板，并可在命令后附上搜索词。面板显示后端为当前工作区报告的技能，在第一条消息发出前也可以打开。

OpenCode 使用 PATH 中的 CLI。本机也可用 `SPAN_OPENCODE_PATH` 指定可执行文件。SSH 会按顺序查找远端的 PATH、`~/.opencode/bin` 和 `~/.local/bin`。新会话默认使用远端登录目录，已保存的会话从其原工作目录恢复。OpenCode 回放的历史由 Span 按需向上分页。 [OpenCode ACP 文档](https://opencode.ai/docs/cli/acp/)

Claude Code 使用 PATH 中的 `claude-agent-acp`，本机可用 `SPAN_CLAUDE_ACP_PATH` 指定适配器。SSH 使用远端 PATH、`~/.claude-agent-acp/bin` 或 `~/.local/bin`。EL8 使用 glibc 的 Linux 发行包。独立发行包内的适配器与 Claude CLI 放在同一目录。Claude 的认证和会话仍由该主机上的 Claude Code 管理。 [Claude Agent ACP](https://github.com/agentclientprotocol/claude-agent-acp)

Kilo 使用 PATH 中的 CLI，本机可用 `SPAN_KILO_PATH` 指定可执行文件。SSH 使用远端 PATH、`~/.kilo/bin` 或 `~/.local/bin`。两种 ACP 后端各自管理会话，以后端、主机和原始会话 ID 区分读取和恢复。 [Kilo CLI 参考](https://kilo.ai/docs/code-with-ai/platforms/cli-reference#kilo-acp)

Kilo Goal 的状态与结果保存在 Kilo 的会话中。Span 从同一 ACP 进程的本机认证接口读写，SSH 会话沿用该连接的本地转发。重新打开会话时，目标卡片从后端恢复。 [Kilo Session Goals](https://kilo.ai/docs/code-with-ai/agents/goals)

OpenCode 和 Kilo 的原生委派显示为子代理卡片。后端提供子会话 ID 后，可查看已保存的任务、推理、工具和答复。打开详情时才通过同一 ACP 进程的认证接口读取记录，按需向上分页；SSH 沿用同一个本地转发。 [OpenCode ACP 文档](https://opencode.ai/docs/cli/acp/) · [Kilo 会话历史](https://kilo.ai/docs/code-with-ai/agents/session-history)

工作台启动时恢复上次成功连接的 Agent、主机和本地工作区。每个连接保留自己最后打开的会话，点击「新会话」后会记住空白状态。无法连接时，可以重试或从连接设置选择其他后端、主机和本地目录。首次启动默认连接本机 Codex。

推理卡片读取后端提供的摘要。命令、补丁、任务计划、子代理、工具调用和用户交互使用专用条目。实时增量按接收顺序刷新，历史向上分页，折叠的详情在展开时渲染。

Codex 会话搜索查询当前主机的历史目录，并沿用当前的归档范围。App Server 的标题匹配区分大小写。侧栏也按标题、原始 ID 和工作区筛选已加载的会话。适配器未声明后端搜索时，通过逐页加载扩大筛选范围。 [Codex App Server 搜索参数](https://learn.chatgpt.com/docs/app-server#list-threads-with-pagination--filters)

`npm run check` 运行协议和时间线测试。Electron 打包、EL8/Windows 冒烟、以及使用真实 App Server 验证本机和 SSH 连接由 `web-workbench-preview.yml` 运行。
