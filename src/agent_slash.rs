use super::{Agent, Request as AgentRequest, Selection, agent_render, array, limited};
use gtk::prelude::*;
use serde_json::{Value, json};
use std::rc::Rc;

pub(super) struct Request {
    generation: u64,
    action: Action,
}

enum Action {
    Rename(String),
    Review,
    Compact,
    Diff { cached: bool },
    Untracked(String),
    Mcp { verbose: bool },
}

impl Agent {
    pub(super) fn extended_command(self: &Rc<Self>, name: &str, args: &str, draft: &str) {
        let result = self.run_slash_command(name, args, draft);
        self.commands.hide();
        match result {
            Ok(true) => self.replace_command(draft, ""),
            Ok(false) => {}
            Err(message) => self.show_status(message),
        }
    }

    fn run_slash_command(
        self: &Rc<Self>,
        name: &str,
        args: &str,
        draft: &str,
    ) -> Result<bool, &'static str> {
        match (name, args) {
            ("/reasoning", effort) => self.options.reasoning_command(effort)?,
            ("/status", "") => self.slash_status()?,
            ("/usage", "") => {
                if !self.initialized.get() {
                    return Err("请先连接 Codex。");
                }
                self.usage.plan.button.emit_clicked();
            }
            ("/copy", format @ ("" | "markdown" | "rich")) => {
                let reply = self.last_copy.borrow();
                let reply = reply.as_ref().ok_or("当前会话没有可复制的完整回复。")?;
                if format == "rich" {
                    if !agent_render::copy_rich(reply.as_ref().clone()) {
                        return Err("无法复制富文本。");
                    }
                } else {
                    agent_render::clipboard().set_text(reply);
                }
                self.show_status("已复制最近一轮回复。");
            }
            ("/pwd" | "/cwd", "") => {
                self.slash_thread(false)?;
                let cwd = self.context.borrow().cwd.to_string_lossy().into_owned();
                self.slash_output("工作目录", &cwd);
            }
            ("/resume" | "/agents", "") => {
                let window = self
                    .panel
                    .toplevel()
                    .and_downcast::<gtk::ApplicationWindow>();
                let action = window
                    .and_then(|window| window.lookup_action("agent-catalog"))
                    .ok_or("无法打开会话列表。")?;
                action.activate(None);
            }
            ("/new" | "/clear", _) => {
                self.slash_idle()?;
                if !self.initialized.get() && !args.is_empty() {
                    return Err("请先连接 Codex，再为新会话指定名称。");
                }
                self.resume.set_text("");
                if self.initialized.get() {
                    self.open_named_thread((!args.is_empty()).then(|| args.to_owned()));
                } else {
                    self.open();
                }
            }
            ("/resume" | "/fork", _) => {
                let thread = self.slash_thread(true)?;
                if name == "/resume" {
                    if args.split_whitespace().count() != 1 {
                        return Err("用法：/resume <会话 ID>，或使用 /resume 打开列表。");
                    }
                    if args == thread {
                        return Err("当前已打开这个会话。");
                    }
                    self.resume.set_text(args);
                    self.open_thread();
                } else {
                    if !args.is_empty() {
                        return Err("用法：/fork，复制当前会话。");
                    }
                    self.begin_fork(&thread);
                }
            }
            ("/rename", "") => {
                self.slash_thread(false)?;
                self.replace_command(draft, "/rename ");
                self.show_status("输入新名称，然后按 Enter。");
                return Ok(false);
            }
            ("/rename", name) => {
                let thread = self.slash_thread(false)?;
                self.rename_thread(&thread, name);
            }
            ("/plan", prompt) => {
                self.slash_thread(true)?;
                if self.options.effective_model().is_empty() {
                    return Err("请等模型列表加载完成。");
                }
                let enabled = !prompt.is_empty() || self.plan_mode.get() != Some(true);
                self.plan_mode.set(Some(enabled));
                self.plan_badge.set_visible(enabled);
                if !prompt.is_empty() {
                    self.send(Some(prompt));
                    return Ok(false);
                }
                self.show_status(if enabled {
                    "规划模式已启用。"
                } else {
                    "已退出规划模式。"
                });
            }
            ("/review", args) => {
                let thread = self.slash_thread(true)?;
                let target = review_target(args)?;
                self.begin_special_turn("正在启动代码审查…");
                self.request_slash(
                    Action::Review,
                    "review/start",
                    json!({"threadId":thread,"target":target}),
                );
            }
            ("/compact", "") => {
                let thread = self.slash_thread(true)?;
                self.begin_special_turn("正在压缩上下文…");
                self.request_slash(
                    Action::Compact,
                    "thread/compact/start",
                    json!({"threadId":thread}),
                );
            }
            ("/diff", "") => {
                self.slash_thread(false)?;
                self.request_diff(false);
            }
            ("/mcp", "" | "verbose") => {
                let thread = self.slash_thread(false)?;
                self.show_status("正在读取 MCP 服务器…");
                self.request_slash(
                    Action::Mcp {
                        verbose: !args.is_empty(),
                    },
                    "mcpServerStatus/list",
                    json!({"threadId":thread,"limit":50,"detail":"toolsAndAuthOnly"}),
                );
            }
            _ => return Err("此命令不接受这些参数。输入 / 查看可用命令。"),
        }
        Ok(true)
    }

    fn slash_thread(&self, idle: bool) -> Result<String, &'static str> {
        if self.opening.get() {
            return Err("请等会话切换完成。");
        }
        if idle {
            self.slash_idle()?;
        }
        self.thread.borrow().clone().ok_or("请先打开 Codex 会话。")
    }

    fn slash_idle(&self) -> Result<(), &'static str> {
        if self.opening.get() || (self.rpc.borrow().is_some() && !self.initialized.get()) {
            return Err("请等会话连接完成。");
        }
        if self.active.get()
            || self.uploading.get()
            || self.pasting.get()
            || self.pending_user.borrow().is_some()
            || !self.questions.borrow().is_empty()
        {
            return Err("请先结束当前任务。");
        }
        Ok(())
    }

    fn begin_fork(&self, thread: &str) {
        self.opening.set(true);
        self.update_controls();
        self.show_status("正在复制会话…");
        self.request(
            AgentRequest::Open {
                resume: true,
                name: None,
            },
            "thread/fork",
            json!({"threadId":thread,"excludeTurns":true}),
        );
    }

    pub(super) fn rename_thread(&self, thread: &str, name: &str) {
        self.request_slash(
            Action::Rename(name.into()),
            "thread/name/set",
            json!({"threadId":thread,"name":name}),
        );
    }

    pub(super) fn apply_plan_mode(&self, params: &mut Value, selection: &Selection) {
        if let Some(plan) = self.plan_mode.get() {
            let model = self.options.effective_model();
            params["collaborationMode"] = json!({
                "mode":if plan {"plan"} else {"default"},
                "settings":{"model":model,"reasoning_effort":selection.effort,"developer_instructions":null}
            });
        }
    }

    fn begin_special_turn(&self, status: &str) {
        self.special_turn.set(true);
        self.active.set(true);
        self.follow_tail.set(true);
        self.show_status(status);
        self.update_controls();
    }

    fn request_slash(&self, action: Action, method: &str, params: Value) {
        let generation = self.history_generation.get();
        self.request(
            AgentRequest::Slash(Request { generation, action }),
            method,
            params,
        );
    }

    fn git_command(&self, action: Action, command: &[&str]) {
        let cwd = self.context.borrow().cwd.to_string_lossy().into_owned();
        self.request_slash(
            action,
            "command/exec",
            json!({
                "command":command,"cwd":cwd,"timeoutMs":10000,"outputBytesCap":262144,
            }),
        );
    }

    fn request_diff(&self, cached: bool) {
        self.show_status("正在读取工作区改动…");
        let mut args = vec![
            "git",
            "--no-pager",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
        ];
        args.extend(if cached {
            ["--cached", "--"]
        } else {
            ["HEAD", "--"]
        });
        self.git_command(Action::Diff { cached }, &args);
    }

    pub(super) fn slash_response(&self, request: Request, result: Result<&Value, &str>) {
        if request.generation != self.history_generation.get() {
            return;
        }
        let result = match result {
            Ok(result) => result,
            Err(message) => {
                if matches!(request.action, Action::Review | Action::Compact)
                    && self.special_turn.replace(false)
                {
                    self.active.set(false);
                    self.turn.take();
                    self.update_controls();
                }
                self.show_status(message);
                return;
            }
        };
        match request.action {
            Action::Rename(name) => {
                self.catalog_fetch.take();
                self.load_catalog(None);
                self.show_status(&format!("已重命名为 {}", limited(&name, 100)));
            }
            Action::Review => {
                if self.special_turn.get() && self.turn.borrow().is_none() {
                    self.turn
                        .replace(result["turn"]["id"].as_str().map(str::to_owned));
                    self.update_controls();
                }
            }
            Action::Compact => {}
            Action::Diff { cached } => {
                let stderr = result["stderr"].as_str().unwrap_or_default();
                if result["exitCode"] == 0 {
                    self.git_command(
                        Action::Untracked(result["stdout"].as_str().unwrap_or_default().to_owned()),
                        &["git", "ls-files", "--others", "--exclude-standard"],
                    );
                } else if !cached && stderr.contains("HEAD") {
                    self.request_diff(true);
                } else {
                    self.show_status(if stderr.is_empty() {
                        "无法读取 Git 改动。"
                    } else {
                        stderr
                    });
                }
            }
            Action::Untracked(diff) => {
                self.show_status("就绪");
                if !diff.is_empty() {
                    let card = super::DiffCard::new("工作区 Git 改动");
                    card.update(&diff);
                    self.append(card.widget());
                }
                if result["exitCode"] != 0 {
                    self.show_status(result["stderr"].as_str().unwrap_or("无法列出未跟踪文件。"));
                } else if let Some(paths) =
                    result["stdout"].as_str().filter(|paths| !paths.is_empty())
                {
                    self.slash_output("未跟踪文件", paths);
                } else if diff.is_empty() {
                    self.slash_output("工作区 Git 改动", "当前工作区没有改动。");
                }
            }
            Action::Mcp { verbose } => {
                let mut lines = Vec::new();
                for server in array(&result["data"]).take(50) {
                    let name = server["name"].as_str().unwrap_or("MCP");
                    let auth = server["authStatus"].as_str().unwrap_or("unknown");
                    let tools = server["tools"].as_object();
                    lines.push(format!(
                        "{name} · {auth} · {} 个工具",
                        tools.map_or(0, |tools| tools.len())
                    ));
                    if verbose && let Some(tools) = tools {
                        lines.extend(tools.keys().take(80).map(|name| format!("    {name}")));
                    }
                    if let Some(error) = server["toolsError"].as_str() {
                        lines.push(format!("    {}", limited(error, 500)));
                    }
                }
                if lines.is_empty() {
                    lines.push("当前会话未返回 MCP 服务器。".into());
                } else if result["nextCursor"].is_string() {
                    lines.push("仅显示前 50 个服务器。".into());
                }
                self.show_status("就绪");
                self.slash_output("MCP 服务器", &limited(&lines.join("\n"), 32768));
            }
        }
    }

    fn slash_status(&self) -> Result<(), &'static str> {
        let thread = self.slash_thread(false)?;
        let directory = self.context.borrow().cwd.to_string_lossy().into_owned();
        let model = self.options.effective_model();
        let context = self.usage.context_summary();
        let quota = self.usage.quota_summary();
        self.slash_output(
            "会话状态",
            &format!(
                "会话 ID  {thread}\n工作目录  {directory}\n模型  {model}\n\n{context}\n\n{quota}"
            ),
        );
        Ok(())
    }

    fn slash_output(&self, title: &str, text: &str) {
        let card = agent_render::CodeCard::new(title, &format!("复制{title}"));
        card.plain_text(text, &self.quote_action());
        self.append(&card.panel);
    }

    pub(super) fn reset_slash_state(&self) {
        self.last_copy.take();
        self.plan_mode.set(None);
        self.plan_badge.hide();
        self.special_turn.set(false);
    }
}

fn review_target(args: &str) -> Result<Value, &'static str> {
    let (flag, value) = args.split_once(char::is_whitespace).unwrap_or((args, ""));
    let value = value.trim();
    match flag {
        "" => Ok(json!({"type":"uncommittedChanges"})),
        "--base" | "--commit" if value.is_empty() || value.split_whitespace().count() != 1 => {
            Err("用法：/review [--base 分支 | --commit SHA | 自定义审查重点]")
        }
        "--base" => Ok(json!({"type":"baseBranch","branch":value})),
        "--commit" => Ok(json!({"type":"commit","sha":value})),
        _ => Ok(json!({"type":"custom","instructions":args})),
    }
}
