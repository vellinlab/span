use crate::hosts::Host;
use gtk::glib;
use gtk::prelude::*;
use std::io::{self, Write};

pub fn edit(
    parent: &gtk::ApplicationWindow,
    title: &str,
    confirm: &str,
    host: Option<&Host>,
    interactive_login: bool,
    persist: impl Fn(&Host) -> Result<(), String>,
) -> Option<Host> {
    let dialog = gtk::Dialog::builder()
        .transient_for(parent)
        .use_header_bar(1)
        .title(title)
        .modal(true)
        .destroy_with_parent(true)
        .resizable(false)
        .default_width(416)
        .build();
    dialog.style_context().add_class("workbench-dialog");
    dialog.add_button("取消", gtk::ResponseType::Cancel);
    dialog
        .add_button(confirm, gtk::ResponseType::Accept)
        .style_context()
        .add_class("primary");
    dialog.set_default_response(gtk::ResponseType::Accept);

    let body = dialog.content_area();
    body.style_context().add_class("dialog-body");
    body.set_spacing(14);

    let name = gtk::Entry::builder()
        .placeholder_text("例如 开发服务器")
        .activates_default(true)
        .build();
    let target = gtk::Entry::builder()
        .placeholder_text("例如 dev 或 user@host")
        .activates_default(true)
        .build();
    let x11 = gtk::CheckButton::with_label("信任 X11 转发");
    x11.set_tooltip_text(Some("允许可信远端读取本机 X11 剪贴板，可用于粘贴图片。"));
    if let Some(host) = host {
        name.set_text(&host.name);
        target.set_text(&host.target);
        x11.set_active(host.trusted_x11);
    }
    let error = gtk::Label::builder().xalign(0.0).wrap(true).build();
    error.style_context().add_class("form-error");
    error.set_no_show_all(true);

    for (label, entry) in [("显示名称（可选）", &name), ("SSH 目标", &target)] {
        let field = gtk::Box::new(gtk::Orientation::Vertical, 6);
        let label = gtk::Label::builder().label(label).xalign(0.0).build();
        label.set_mnemonic_widget(Some(entry));
        field.pack_start(&label, false, false, 0);
        field.pack_start(entry, false, false, 0);
        body.pack_start(&field, false, false, 0);
    }
    if cfg!(unix) {
        body.pack_start(&x11, false, false, 0);
    }
    if interactive_login {
        let hint = gtk::Label::builder()
            .label("需要密码或验证码时，SSH 会弹出输入窗口，或在终端显示提示。")
            .wrap(true)
            .xalign(0.0)
            .build();
        hint.style_context().add_class("preview-detail");
        body.pack_start(&hint, false, false, 0);
    }
    body.pack_start(&error, false, false, 0);
    dialog.show_all();
    target.grab_focus();

    let mut saved = None;
    while dialog.run() == gtk::ResponseType::Accept {
        match Host::new(
            name.text().as_str(),
            target.text().as_str(),
            x11.is_active(),
        ) {
            Ok(host) => match persist(&host) {
                Ok(()) => {
                    saved = Some(host);
                    break;
                }
                Err(message) => error.set_text(&message),
            },
            Err(message) => {
                error.set_text(message);
                target.grab_focus();
            }
        }
        error.show();
    }
    dialog.close();
    saved
}

pub fn import(
    parent: &gtk::ApplicationWindow,
    candidates: &[Host],
    hint: &str,
    persist: impl Fn(Vec<Host>) -> Result<(), String>,
) -> bool {
    let dialog = gtk::Dialog::builder()
        .transient_for(parent)
        .use_header_bar(1)
        .title("导入 OpenSSH 主机")
        .modal(true)
        .destroy_with_parent(true)
        .resizable(false)
        .default_width(416)
        .build();
    dialog.style_context().add_class("workbench-dialog");
    let body = dialog.content_area();
    body.style_context().add_class("dialog-body");
    body.set_spacing(12);
    let label = gtk::Label::builder()
        .label(hint)
        .xalign(0.0)
        .wrap(true)
        .build();
    body.add(&label);
    if candidates.is_empty() {
        dialog.add_button("关闭", gtk::ResponseType::Close);
        dialog.show_all();
        dialog.run();
        dialog.close();
        return false;
    }

    dialog.add_button("取消", gtk::ResponseType::Cancel);
    dialog
        .add_button("导入所选", gtk::ResponseType::Accept)
        .style_context()
        .add_class("primary");
    dialog.set_response_sensitive(gtk::ResponseType::Accept, false);
    let list = gtk::Box::new(gtk::Orientation::Vertical, 6);
    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vscrollbar_policy(gtk::PolicyType::Automatic)
        .propagate_natural_height(true)
        .max_content_height(260)
        .build();
    scroll.add(&list);
    body.add(&scroll);
    let error = gtk::Label::builder().xalign(0.0).wrap(true).build();
    error.style_context().add_class("form-error");
    error.set_no_show_all(true);
    body.add(&error);
    let choices: Vec<_> = candidates
        .iter()
        .map(|host| {
            let choice = gtk::CheckButton::with_label(&host.target);
            let weak_dialog = dialog.downgrade();
            let weak_list = list.downgrade();
            choice.connect_toggled(move |_| {
                if let (Some(dialog), Some(list)) = (weak_dialog.upgrade(), weak_list.upgrade()) {
                    let checked = list
                        .children()
                        .into_iter()
                        .any(|child| child.downcast::<gtk::CheckButton>().unwrap().is_active());
                    dialog.set_response_sensitive(gtk::ResponseType::Accept, checked);
                }
            });
            list.add(&choice);
            choice
        })
        .collect();
    dialog.show_all();
    let mut saved = false;
    while dialog.run() == gtk::ResponseType::Accept {
        let selected = choices
            .iter()
            .zip(candidates)
            .filter(|(choice, _)| choice.is_active())
            .map(|(_, host)| host.clone())
            .collect();
        match persist(selected) {
            Ok(()) => {
                saved = true;
                break;
            }
            Err(message) => {
                error.set_text(&message);
                error.show();
            }
        }
    }
    dialog.close();
    saved
}

pub fn askpass(prompt: &str) -> glib::ExitCode {
    let hint = std::env::var("SSH_ASKPASS_PROMPT").unwrap_or_default();
    let confirm =
        hint == "confirm" || prompt.contains("(yes/no") && prompt.contains("continue connecting");
    let notice = hint == "none";
    let dialog = gtk::Dialog::builder()
        .title("SSH 身份验证")
        .window_position(gtk::WindowPosition::Center)
        .default_width(440)
        .modal(true)
        .use_header_bar(1)
        .build();
    dialog.set_keep_above(true);
    dialog.style_context().add_class("workbench-dialog");
    dialog.add_button("取消", gtk::ResponseType::Cancel);
    let ok = if confirm {
        "继续连接"
    } else if notice {
        "继续"
    } else {
        "确认"
    };
    dialog
        .add_button(ok, gtk::ResponseType::Accept)
        .style_context()
        .add_class("primary");
    dialog.set_default_response(if confirm {
        gtk::ResponseType::Cancel
    } else {
        gtk::ResponseType::Accept
    });
    let body = dialog.content_area();
    body.style_context().add_class("dialog-body");
    body.set_spacing(12);
    let label = gtk::Label::builder()
        .label(prompt)
        .wrap(true)
        .selectable(true)
        .xalign(0.0)
        .build();
    body.add(&label);
    let secret = gtk::Entry::builder()
        .visibility(false)
        .input_purpose(gtk::InputPurpose::Password)
        .placeholder_text("密码或验证码")
        .activates_default(true)
        .build();
    if !confirm && !notice {
        body.add(&secret);
    }
    dialog.show_all();
    if !confirm && !notice {
        secret.grab_focus();
    }
    let accepted = dialog.run() == gtk::ResponseType::Accept;
    let value = secret.text();
    secret.set_text("");
    dialog.close();
    if !accepted {
        return glib::ExitCode::FAILURE;
    }
    let reply = if confirm { "yes" } else { value.as_str() };
    match writeln!(io::stdout().lock(), "{reply}") {
        Ok(()) => glib::ExitCode::SUCCESS,
        Err(_) => glib::ExitCode::FAILURE,
    }
}

pub fn confirm_delete(parent: &gtk::ApplicationWindow, host: &Host) -> bool {
    let dialog = gtk::MessageDialog::builder()
        .transient_for(parent)
        .modal(true)
        .destroy_with_parent(true)
        .message_type(gtk::MessageType::Question)
        .text(format!("删除「{}」？", host.name))
        .secondary_text("此操作删除保存的主机。已打开的会话仍可使用。")
        .build();
    dialog.style_context().add_class("workbench-dialog");
    dialog.add_button("取消", gtk::ResponseType::Cancel);
    dialog
        .add_button("删除", gtk::ResponseType::Accept)
        .style_context()
        .add_class("destructive");
    dialog.set_default_response(gtk::ResponseType::Cancel);
    let accepted = dialog.run() == gtk::ResponseType::Accept;
    dialog.close();
    accepted
}
