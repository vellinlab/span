use crate::hosts::Host;
use gtk::prelude::*;

pub fn edit(
    parent: &gtk::ApplicationWindow,
    title: &str,
    confirm: &str,
    host: Option<&Host>,
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
    body.set_spacing(10);

    let name = gtk::Entry::builder()
        .placeholder_text("例如 东京开发")
        .activates_default(true)
        .build();
    let target = gtk::Entry::builder()
        .placeholder_text("例如 tokyo 或 user@host")
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
        let label = gtk::Label::builder().label(label).xalign(0.0).build();
        label.set_mnemonic_widget(Some(entry));
        body.pack_start(&label, false, false, 0);
        body.pack_start(entry, false, false, 0);
    }
    body.pack_start(&x11, false, false, 4);
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
