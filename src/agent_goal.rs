use super::{Agent, Request, limited};
use gtk::glib;
use gtk::prelude::*;
use serde_json::{Value, json};
use std::rc::Rc;

const MAX_OBJECTIVE: usize = 4000;

pub(super) enum Action {
    Refresh(u64),
    Command {
        edit: bool,
        draft: String,
    },
    Save {
        draft: String,
        dialog: glib::WeakRef<gtk::Dialog>,
        error: glib::WeakRef<gtk::Label>,
        scroll: glib::WeakRef<gtk::ScrolledWindow>,
    },
}

impl Agent {
    pub(super) fn goal_command(self: &Rc<Self>, arguments: &str, draft: &str) {
        let Some(thread) = self.thread.borrow().clone().filter(|_| !self.opening.get()) else {
            self.show_status("请先打开 Codex 会话。");
            return;
        };
        if arguments.is_empty() {
            self.open_goal_editor(thread, draft.to_owned());
            return;
        }
        if self.goal_pending.get() {
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

    fn open_goal_editor(self: &Rc<Self>, thread: String, draft: String) {
        let Some(parent) = self.panel.toplevel().and_downcast::<gtk::Window>() else {
            return;
        };
        let dialog = gtk::Dialog::builder()
            .transient_for(&parent)
            .title("设置目标")
            .use_header_bar(1)
            .modal(true)
            .destroy_with_parent(true)
            .default_width(500)
            .build();
        dialog.style_context().add_class("workbench-dialog");
        dialog.add_button("取消", gtk::ResponseType::Cancel);
        let submit = dialog.add_button("发送目标", gtk::ResponseType::Accept);
        submit.style_context().add_class("primary");
        submit.set_tooltip_text(Some("Ctrl+Enter"));
        submit.set_sensitive(false);

        let input = gtk::TextView::builder()
            .wrap_mode(gtk::WrapMode::WordChar)
            .accepts_tab(false)
            .top_margin(8)
            .bottom_margin(8)
            .left_margin(10)
            .right_margin(10)
            .build();
        if let Some(accessible) = input.accessible() {
            accessible.set_name("会话目标输入框");
        }
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .min_content_height(122)
            .build();
        scroll.style_context().add_class("goal-editor-input");
        scroll.add(&input);
        let hint = gtk::Label::builder()
            .label("描述你希望在此会话中达成的目标")
            .xalign(0.0)
            .mnemonic_widget(&input)
            .build();
        let error = gtk::Label::builder()
            .xalign(0.0)
            .wrap(true)
            .max_width_chars(52)
            .no_show_all(true)
            .build();
        error.style_context().add_class("form-error");
        let body = dialog.content_area();
        body.style_context().add_class("dialog-body");
        body.set_spacing(10);
        body.pack_start(&hint, false, false, 0);
        body.pack_start(&scroll, true, true, 0);
        body.pack_start(&error, false, false, 0);

        let Some(buffer) = input.buffer() else { return };
        let weak_submit = submit.downgrade();
        buffer.connect_changed(move |buffer| {
            if let Some(submit) = weak_submit.upgrade() {
                submit.set_sensitive(!buffer_text(buffer).trim().is_empty());
            }
        });
        let weak_dialog = dialog.downgrade();
        input.connect_key_press_event(move |input, event| {
            use gtk::gdk::{
                ModifierType,
                keys::constants::{KP_Enter, Return},
            };
            if [Return, KP_Enter].contains(&event.keyval())
                && event.state() & gtk::accelerator_get_default_mod_mask()
                    == ModifierType::CONTROL_MASK
                && !input.im_context_filter_keypress(event)
                && let Some(dialog) = weak_dialog.upgrade()
            {
                dialog.response(gtk::ResponseType::Accept);
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        let weak = Rc::downgrade(self);
        let generation = self.history_generation.get();
        dialog.connect_response(move |dialog, response| {
            if response != gtk::ResponseType::Accept {
                dialog.close();
                return;
            }
            let Some(agent) = weak.upgrade() else { return };
            if agent.thread.borrow().as_deref() != Some(thread.as_str())
                || agent.history_generation.get() != generation
                || agent.opening.get()
            {
                error.set_text("当前会话已断开或切换，请回到原会话后重新打开目标编辑器。");
                error.show();
                return;
            }
            if agent.goal_pending.get() {
                return;
            }
            let params = match objective_params(&thread, buffer_text(&buffer).trim()) {
                Ok(params) => params,
                Err(message) => {
                    error.set_text(message);
                    error.show();
                    return;
                }
            };
            error.hide();
            dialog.set_response_sensitive(gtk::ResponseType::Accept, false);
            scroll.set_sensitive(false);
            agent.request_goal(
                Action::Save {
                    draft: draft.clone(),
                    dialog: dialog.downgrade(),
                    error: error.downgrade(),
                    scroll: scroll.downgrade(),
                },
                "thread/goal/set",
                params,
            );
        });
        dialog.show_all();
        input.grab_focus();
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
    }

    pub(super) fn goal_failed(&self, action: &Action, message: &str) {
        if matches!(action, Action::Refresh(_)) {
            return;
        }
        self.goal_pending.set(false);
        if let Action::Save {
            dialog,
            error,
            scroll,
            ..
        } = action
            && let (Some(dialog), Some(error), Some(scroll)) =
                (dialog.upgrade(), error.upgrade(), scroll.upgrade())
        {
            dialog.set_response_sensitive(gtk::ResponseType::Accept, true);
            scroll.set_sensitive(true);
            error.set_text(&message.replace('\0', "�"));
            error.show();
        } else {
            self.show_status(message);
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
                    self.goal.hide();
                    self.show_status("已清除会话目标");
                } else {
                    self.render_goal(&result["goal"]);
                    if result["goal"].is_null() {
                        self.show_status("当前会话没有目标。");
                    }
                }
                let replacement = if edit {
                    format!(
                        "/goal {}",
                        result["goal"]["objective"].as_str().unwrap_or_default()
                    )
                } else {
                    String::new()
                };
                self.replace_command(&draft, &replacement);
            }
            Action::Save { draft, dialog, .. } => {
                self.goal_pending.set(false);
                self.render_goal(&result["goal"]);
                self.replace_command(&draft, "");
                if let Some(dialog) = dialog.upgrade() {
                    dialog.close();
                }
                self.input.grab_focus();
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
            self.goal.hide();
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
        let text = format!("目标 · {status}\n{}", limited(objective, MAX_OBJECTIVE));
        self.goal.set_tooltip_text(Some(&text));
        self.goal.set_text(&text);
        self.goal.show();
    }
}

fn buffer_text(buffer: &gtk::TextBuffer) -> glib::GString {
    buffer
        .text(&buffer.start_iter(), &buffer.end_iter(), false)
        .unwrap_or_default()
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
