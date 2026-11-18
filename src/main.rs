use vte4::gtk::{self, gdk, gio, glib};
use vte4::prelude::*;

fn main() -> glib::ExitCode {
    let app = gtk::Application::builder()
        .application_id("io.github.zyw02.SshWorkbench")
        .build();
    app.connect_activate(build_window);
    app.run()
}

fn build_window(app: &gtk::Application) {
    if let Some(window) = app.active_window() {
        window.present();
        return;
    }

    let (local, local_terminal) = local_pane();
    let remote = remote_pane();
    let split = gtk::Paned::builder()
        .orientation(gtk::Orientation::Horizontal)
        .wide_handle(true)
        .position(540)
        .build();
    split.set_start_child(Some(&local));
    split.set_end_child(Some(&remote));
    split.set_shrink_start_child(false);
    split.set_shrink_end_child(false);
    split.set_resize_start_child(true);
    split.set_resize_end_child(true);

    let window = gtk::ApplicationWindow::builder()
        .application(app)
        .title("SSH Workbench")
        .default_width(1080)
        .default_height(640)
        .child(&split)
        .build();
    window.present();
    local_terminal.grab_focus();
}

fn local_pane() -> (gtk::Box, vte4::Terminal) {
    let heading = gtk::Label::new(Some("本地 Bash"));
    let status = gtk::Label::new(None);
    let restart = gtk::Button::with_label("启动 Bash");
    let header = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    header.append(&heading);
    header.append(&status);
    header.append(&restart);

    let (pane, terminal) = terminal_pane(&header);
    terminal.connect_child_exited(glib::clone!(
        #[weak]
        status,
        #[weak]
        restart,
        move |terminal, _| {
            terminal.set_input_enabled(false);
            status.set_label("Bash 已退出");
            restart.set_visible(true);
        }
    ));
    restart.connect_clicked(glib::clone!(
        #[weak]
        terminal,
        #[weak]
        status,
        move |button| start_bash(&terminal, &status, button)
    ));
    start_bash(&terminal, &status, &restart);
    (pane, terminal)
}

fn start_bash(terminal: &vte4::Terminal, status: &gtk::Label, restart: &gtk::Button) {
    restart.set_visible(false);
    terminal.reset(true, false);
    terminal.set_input_enabled(true);
    status.set_label("");
    let home = glib::home_dir();
    spawn(
        terminal,
        home.to_str(),
        &["/bin/bash", "-l"],
        glib::clone!(
            #[weak]
            terminal,
            #[weak]
            status,
            #[weak]
            restart,
            move |result: Result<glib::Pid, glib::Error>| {
                if let Err(error) = result {
                    show_error(&terminal, &status, "Bash 启动失败", &error);
                    restart.set_visible(true);
                }
            }
        ),
    );
    terminal.grab_focus();
}

fn remote_pane() -> gtk::Box {
    let heading = gtk::Label::new(Some("SSH"));
    let target = gtk::Entry::builder()
        .text("tokyo")
        .placeholder_text("SSH 主机别名")
        .tooltip_text("SSH 主机别名或 user@host")
        .width_chars(9)
        .max_width_chars(22)
        .hexpand(true)
        .build();
    let x11 = gtk::CheckButton::with_label("信任 X11");
    x11.set_tooltip_text(Some("允许远端程序访问本机的 X11 会话。仅用于信任的主机。"));
    let connect = gtk::Button::with_label("连接");
    let status = gtk::Label::new(Some("等待连接"));
    let header = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    header.append(&heading);
    header.append(&target);
    header.append(&x11);
    header.append(&connect);

    let (pane, terminal) = terminal_pane(&header);
    status.set_xalign(0.0);
    status.set_margin_start(10);
    status.set_margin_bottom(6);
    pane.append(&status);
    terminal.set_input_enabled(false);

    connect.connect_clicked(glib::clone!(
        #[weak]
        terminal,
        #[weak]
        target,
        #[weak]
        x11,
        #[weak]
        status,
        move |button| {
            let entered = target.text();
            let host = entered.trim();
            if host.is_empty() || host.starts_with('-') || host.chars().any(char::is_whitespace) {
                status.set_label("请输入有效的 SSH 主机别名或 user@host");
                target.grab_focus();
                return;
            }

            let mut argv = vec!["/usr/bin/ssh"];
            if x11.is_active() {
                argv.extend(["-Y", "-S", "none"]);
            }
            argv.extend(["--", host]);

            set_connecting(&target, &x11, button, true);
            status.set_label("SSH 连接与验证信息见终端");
            terminal.reset(true, false);
            terminal.set_input_enabled(true);
            terminal.grab_focus();
            spawn(
                &terminal,
                None,
                &argv,
                glib::clone!(
                    #[weak]
                    terminal,
                    #[weak]
                    target,
                    #[weak]
                    x11,
                    #[weak]
                    status,
                    #[weak]
                    button,
                    move |result: Result<glib::Pid, glib::Error>| {
                        if let Err(error) = result {
                            show_error(&terminal, &status, "SSH 启动失败", &error);
                            set_connecting(&target, &x11, &button, false);
                        }
                    }
                ),
            );
        }
    ));
    target.connect_activate(glib::clone!(
        #[weak]
        connect,
        move |_| {
            if connect.is_sensitive() {
                connect.emit_clicked();
            }
        }
    ));
    terminal.connect_child_exited(glib::clone!(
        #[weak]
        target,
        #[weak]
        x11,
        #[weak]
        connect,
        #[weak]
        status,
        move |terminal, _| {
            terminal.set_input_enabled(false);
            status.set_label("SSH 已退出");
            set_connecting(&target, &x11, &connect, false);
        }
    ));
    (pane, terminal)
}

fn set_connecting(
    target: &gtk::Entry,
    x11: &gtk::CheckButton,
    connect: &gtk::Button,
    active: bool,
) {
    target.set_editable(!active);
    x11.set_sensitive(!active);
    connect.set_sensitive(!active);
}

fn terminal_pane(header: &gtk::Box) -> (gtk::Box, vte4::Terminal) {
    header.set_margin_top(8);
    header.set_margin_bottom(8);
    header.set_margin_start(10);
    header.set_margin_end(10);
    let terminal = vte4::Terminal::new();
    terminal.set_scrollback_lines(10_000);

    let keys = gtk::EventControllerKey::new();
    keys.set_propagation_phase(gtk::PropagationPhase::Capture);
    keys.connect_key_pressed(glib::clone!(
        #[weak]
        terminal,
        #[upgrade_or]
        glib::Propagation::Proceed,
        move |_, key, _, modifiers| {
            let shortcut = gdk::ModifierType::CONTROL_MASK | gdk::ModifierType::SHIFT_MASK;
            if !modifiers.contains(shortcut) || modifiers.contains(gdk::ModifierType::ALT_MASK) {
                return glib::Propagation::Proceed;
            }
            match key.to_lower() {
                gdk::Key::c => terminal.copy_clipboard_format(vte4::Format::Text),
                gdk::Key::v => terminal.paste_clipboard(),
                _ => return glib::Propagation::Proceed,
            }
            glib::Propagation::Stop
        }
    ));
    terminal.add_controller(keys);

    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vscrollbar_policy(gtk::PolicyType::Automatic)
        .hexpand(true)
        .vexpand(true)
        .child(&terminal)
        .build();
    let pane = gtk::Box::new(gtk::Orientation::Vertical, 0);
    pane.append(header);
    pane.append(&scroll);
    (pane, terminal)
}

fn spawn(
    terminal: &vte4::Terminal,
    directory: Option<&str>,
    argv: &[&str],
    on_spawn: impl FnOnce(Result<glib::Pid, glib::Error>) + 'static,
) {
    terminal.spawn_async(
        vte4::PtyFlags::DEFAULT,
        directory,
        argv,
        &[],
        glib::SpawnFlags::DEFAULT,
        || {},
        10_000,
        None::<&gio::Cancellable>,
        on_spawn,
    );
}

fn show_error(terminal: &vte4::Terminal, status: &gtk::Label, label: &str, error: &glib::Error) {
    terminal.set_input_enabled(false);
    terminal.feed(format!("\r\n{label}: {error}\r\n").as_bytes());
    status.set_label(label);
}
