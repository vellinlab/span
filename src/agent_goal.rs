use super::{Agent, Request, limited};
use gtk::prelude::*;
use serde_json::{Value, json};
use std::rc::Rc;

const MAX_OBJECTIVE: usize = 4000;

pub(super) enum Action {
    Refresh(u64),
    Command { edit: bool, draft: String },
    Save,
}

impl Agent {
    pub(super) fn goal_command(self: &Rc<Self>, arguments: &str, draft: &str) {
        let Some(thread) = self.thread.borrow().clone().filter(|_| !self.opening.get()) else {
            self.show_status("请先打开 Codex 会话。");
            return;
        };
        if self.goal_pending.get() {
            return;
        }
        if arguments.is_empty() {
            self.begin_goal_draft(draft, "");
            return;
        }
        let (method, params) = match arguments {
            "status" | "edit" => ("thread/goal/get", json!({"threadId":thread})),
            "clear" => (
                "thread/goal/clear",
                json!({"threadId":thread,"origin":"user"}),
            ),
            "pause" | "resume" => (
                "thread/goal/set",
                json!({
                    "threadId":thread,"origin":"user","status": if arguments == "pause" {"paused"} else {"active"}
                }),
            ),
            objective => match objective_params(&thread, objective) {
                Ok(params) => ("thread/goal/set", params),
                Err(error) => {
                    self.show_status(error);
                    return;
                }
            },
        };
        self.request_goal(
            Action::Command {
                edit: arguments == "edit",
                draft: draft.to_owned(),
            },
            method,
            params,
        );
    }

    fn begin_goal_draft(&self, command: &str, objective: &str) {
        if self.editor_text() != command {
            return;
        }
        self.set_goal_mode(true);
        self.replace_command(command, objective);
        if self.panel.is_mapped() {
            self.input.grab_focus();
        }
    }

    pub(super) fn set_goal_mode(&self, enabled: bool) {
        self.goal_mode.set(enabled);
        self.goal_mode_bar.set_visible(enabled);
        self.placeholder.set_text(if enabled {
            "描述你希望在此会话中达成的目标"
        } else {
            "输入消息，或添加附件"
        });
        self.update_controls();
    }

    pub(super) fn cancel_goal_draft(&self) -> bool {
        if !self.goal_mode.get() || self.goal_pending.get() {
            return false;
        }
        self.replace_command(&self.editor_text(), "");
        self.set_goal_mode(false);
        true
    }

    pub(super) fn submit_goal_draft(&self, draft: &str) {
        if self.goal_pending.get() || self.opening.get() || !self.input.is_editable() {
            return;
        }
        let Some(thread) = self.thread.borrow().clone() else {
            self.show_status("请先重连 Codex 会话。");
            return;
        };
        match objective_params(&thread, draft.trim()) {
            Ok(params) => self.request_goal(Action::Save, "thread/goal/set", params),
            Err(message) => self.show_status(message),
        }
    }

    pub(super) fn refresh_goal(&self, thread: &str) {
        self.request(
            Request::Goal {
                generation: self.history_generation.get(),
                action: Action::Refresh(self.goal_revision.get()),
            },
            "thread/goal/get",
            json!({"threadId":thread}),
        );
    }

    fn request_goal(&self, action: Action, method: &str, params: Value) {
        let saving_draft = matches!(action, Action::Save);
        self.goal_pending.set(true);
        self.goal_revision
            .set(self.goal_revision.get().wrapping_add(1));
        self.request(
            Request::Goal {
                generation: self.history_generation.get(),
                action,
            },
            method,
            params,
        );
        if saving_draft {
            self.update_controls();
        }
    }

    pub(super) fn goal_failed(&self, action: &Action, message: &str) {
        if matches!(action, Action::Refresh(_)) {
            return;
        }
        self.goal_pending.set(false);
        self.show_status(message);
        if matches!(action, Action::Save) {
            self.update_controls();
        }
    }

    pub(super) fn goal_response(&self, action: Action, result: &Value) {
        match action {
            Action::Refresh(revision) => {
                if revision == self.goal_revision.get() {
                    self.render_goal(&result["goal"]);
                }
            }
            Action::Command { edit, draft } => {
                self.goal_pending.set(false);
                if result.get("cleared").is_some() {
                    self.goal_card.hide();
                    self.show_status("已清除会话目标");
                } else {
                    self.render_goal(&result["goal"]);
                    if result["goal"].is_null() {
                        self.show_status("当前会话没有目标。");
                    }
                }
                if edit {
                    self.begin_goal_draft(
                        &draft,
                        result["goal"]["objective"].as_str().unwrap_or_default(),
                    );
                } else {
                    self.replace_command(&draft, "");
                }
            }
            Action::Save => {
                self.goal_pending.set(false);
                self.render_goal(&result["goal"]);
                self.replace_command(&self.editor_text(), "");
                self.set_goal_mode(false);
            }
        }
    }

    pub(super) fn goal_updated(&self, goal: &Value) {
        self.goal_revision
            .set(self.goal_revision.get().wrapping_add(1));
        self.render_goal(goal);
    }

    fn render_goal(&self, goal: &Value) {
        let Some(objective) = goal["objective"].as_str() else {
            self.goal_card.hide();
            return;
        };
        let status = match goal["status"].as_str() {
            Some("active") => "进行中",
            Some("paused") => "已暂停",
            Some("blocked") => "受阻",
            Some("complete") => "已完成",
            Some("budgetLimited" | "usageLimited") => "达到用量上限",
            _ => "会话目标",
        };
        let text = format!(
            "目标 · {status}\n{}",
            limited(&crate::agent_interaction::display(objective), MAX_OBJECTIVE)
        );
        self.goal.set_tooltip_text(Some(&text));
        self.goal.set_text(&text);
        let elapsed = goal["timeUsedSeconds"]
            .as_u64()
            .map(|seconds| format!("已执行 {}", crate::agent_interaction::elapsed(seconds)))
            .unwrap_or_default();
        self.goal_elapsed.set_text(&elapsed);
        self.goal_elapsed.set_visible(!elapsed.is_empty());
        self.goal_card.show();
    }
}

fn objective_params(thread: &str, objective: &str) -> Result<Value, &'static str> {
    if objective.is_empty() {
        return Err("请输入会话目标。");
    }
    if objective.chars().count() > MAX_OBJECTIVE {
        return Err("会话目标最多 4,000 个字符。");
    }
    Ok(json!({"threadId":thread,"origin":"user","objective":objective,"status":"active"}))
}
