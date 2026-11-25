# Span Electron 工作台

持续评审的优先级、验收场景和复验方法见[Electron 评审细则](REVIEW.md)。

## Codex 连接

本机和 SSH 都先探测 `CODEX_HOME/app-server-control/app-server-control.sock`。找到端点后，Span 通过 `codex app-server proxy` 建立 WebSocket。端点缺失或代理握手失败时，使用独立的 JSONL App Server。只开放父子进程管道的 ChatGPT 实例无法接受外部客户端连接。把指针移到输入区的连接控件上可以查看实际使用的连接。 [Codex App Server 协议](https://learn.chatgpt.com/docs/app-server)

Windows 本机依次尝试 `SPAN_CODEX_PATH`、`CODEX_CLI_PATH`、PATH、Codex 管理目录、用户安装和运行缓存，以及当前用户注册的 ChatGPT/Codex AppX 的 `resources` 目录。如果 Windows 拒绝执行 AppX 内的文件，可以把 `SPAN_CODEX_PATH` 指向可执行的用户安装版。 [Codex 独立安装与 daemon 文档](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)

## Agent 适配协议

`ui/agent-protocol.d.ts` 定义会话标识、历史分页、交互和事件。会话标识由后端、本机或 SSH 位置和后端原始 ID 组成。适配器负责协议转换、进程及其会话存储，并把历史记录和实时事件都转换成同一种会话条目。

| 后端 | 适配方式与能力 |
| --- | --- |
| Codex | 已注册。本机或 SSH 接入 App Server。使用原生目标、用量、规划、审批、模型和速度档位。时间线显示子代理活动，成员可打开对应会话。 |
| Clue | 已注册。本机或 SSH 使用现有的 `clue app-server` 兼容路径。使用基础会话和回合操作。 |
| Claude Code | 协议可映射 SDK 的会话、流式内容、审批、检查点和子代理。Agent Teams 通过独立的成员、任务和团队操作表示，按可用性启用。 |
| Pi Agent | 已注册。本机和 SSH 启动 `pi --mode rpc`，使用 Pi 自己保存的会话。支持模型和思考级别、`steer`、`follow_up`、会话统计、扩展命令及交互。 |

[Claude Code Agent SDK](https://code.claude.com/docs/en/headless) · [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) · [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)

接入后端时，在 `ui/agent.js` 注册适配器工厂。使用本地或 SSH 进程的适配器在 Rust 服务中声明启动方式。实现会话和回合的基础操作，按能力提供可选操作。界面按能力显示控件，并消费统一事件。后端专属操作使用带命名空间的命令和事件。

Pi 可以使用 PATH 中的 CLI。本机也可用 `SPAN_PI_PATH` 指定可执行文件。工作台读取 Pi 为当前工作区返回的会话目录，通过 Pi RPC 恢复会话，并显示当前历史分支。扩展注册的命令可从斜杠菜单发送给 Pi。 [Pi RPC 协议](https://github.com/earendil-works/pi/blob/v1.6.0/packages/coding-agent/docs/rpc.md)

Codex 和 Pi 在 Agent 菜单中提供「技能」。在输入框用 `/skills` 也可以打开面板，并可在命令后附上搜索词。面板显示后端为当前工作区报告的技能，在第一条消息发出前也可以打开。

工作台启动时恢复上次成功连接的 Agent、主机和本地工作区。每个连接保留自己最后打开的会话，点击「新会话」后会记住空白状态。无法连接时，可以重试或从连接设置选择其他后端、主机和本地目录。首次启动默认连接本机 Codex。

推理卡片读取后端提供的摘要。命令、补丁、任务计划、子代理、工具调用和用户交互使用专用条目。实时增量按接收顺序刷新，历史向上分页，折叠的详情在展开时渲染。

Codex 会话搜索查询当前主机的历史目录，并沿用当前的归档范围。App Server 的标题匹配区分大小写。侧栏也按标题、原始 ID 和工作区筛选已加载的会话。适配器未声明后端搜索时，通过逐页加载扩大筛选范围。 [Codex App Server 搜索参数](https://learn.chatgpt.com/docs/app-server#list-threads-with-pagination--filters)

`npm run check` 运行协议和时间线测试。Electron 打包、EL8/Windows 冒烟、以及使用真实 App Server 验证本机和 SSH 连接由 `web-workbench-preview.yml` 运行。
