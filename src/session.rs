use crate::agent::Agent;
use crate::files::{ControlSocket, Source};
use crate::hosts::Host;
use crate::icons::{self, Icon};
use crate::preview::Panel;
use crate::vte::Terminal;
use gtk::prelude::*;
use gtk::{gdk, gio, glib};
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::{Rc, Weak};

pub enum Launch {
    Local,
    Ssh(Host),
}

impl Launch {
    pub fn label(&self) -> &str {
        match self {
            Self::Local => "本地 Bash",
            Self::Ssh(host) => &host.name,
        }
    }

    pub fn icon(&self) -> Icon {
        match self {
            Self::Local => Icon::Terminal,
            Self::Ssh(_) => Icon::Server,
        }
    }

    pub fn description(&self) -> String {
        match self {
            Self::Local => "本地  /  Bash".into(),
            Self::Ssh(host) => format!("SSH  /  {}", host.target),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum State {
    Starting,
    Running,
    Exited(i32),
    Failed,
}

impl State {
    pub fn can_restart(self) -> bool {
        matches!(self, Self::Exited(_) | Self::Failed)
    }
}

pub struct Session {
    pub launch: Launch,
    pub page: gtk::Stack,
    pub terminal: Terminal,
    pub indicator: gtk::Label,
    pub state: Cell<State>,
    pub directory: RefCell<Option<PathBuf>>,
    cancellable: gio::Cancellable,
    control: RefCell<Option<ControlSocket>>,
    agent: RefCell<Option<Rc<Agent>>>,
    preview: Weak<Panel>,
    shell: gtk::ScrolledWindow,
    agent_view: RefCell<Option<AgentView>>,
    reconnect: RefCell<Option<gio::FileMonitor>>,
}

struct AgentView {
    split: gtk::Paned,
    drawer: gtk::Box,
    tabs: gtk::Stack,
    picker: gtk::ComboBoxText,
    next_shell: Cell<u32>,
    extra_shells: RefCell<Vec<Shell>>,
}

struct Shell {
    id: String,
    page: gtk::ScrolledWindow,
    cancellable: gio::Cancellable,
}

impl Session {
    pub fn new(launch: Launch, preview: Weak<Panel>) -> Rc<Self> {
        let (terminal, scroll) = terminal_widget();
        let page = gtk::Stack::new();
        page.set_homogeneous(false);
        page.add_named(&scroll, "terminal");

        let indicator = gtk::Label::new(Some("●"));
        indicator.style_context().add_class("session-dot");
        let control = new_control_socket(&launch);
        Rc::new(Self {
            launch,
            page,
            terminal,
            indicator,
            state: Cell::new(State::Starting),
            directory: RefCell::new(None),
            cancellable: gio::Cancellable::new(),
            control: RefCell::new(control),
            agent: RefCell::new(None),
            preview,
            shell: scroll,
            agent_view: RefCell::new(None),
            reconnect: RefCell::new(None),
        })
    }

    pub fn toggle_agent(self: &Rc<Self>) {
        if self.page.visible_child_name().as_deref() == Some("agent") {
            if self
                .agent_view
                .borrow()
                .as_ref()
                .is_some_and(|view| view.drawer.is_visible())
            {
                self.toggle_drawer();
            }
            self.page.set_visible_child_name("terminal");
            self.terminal.grab_focus();
            return;
        }
        self.show_agent();
    }

    fn show_agent(self: &Rc<Self>) {
        let agent = self.agent();
        self.page.set_visible_child_name("agent");
        agent.focus();
    }

    pub fn agent(self: &Rc<Self>) -> Rc<Agent> {
        if self.agent.borrow().is_none() {
            let weak = Rc::downgrade(self);
            let drawer_session = weak.clone();
            let reveal_session = weak.clone();
            let preview_session = weak.clone();
            let agent = Agent::new(
                self.launch.label(),
                self.directory.borrow().as_deref(),
                move || {
                    let session = weak.upgrade().ok_or("终端标签已关闭。")?;
                    match session.file_source() {
                        Source::Local => Ok(None),
                        Source::Sftp {
                            socket: Some(socket),
                        } if crate::sftp::socket_ready(&socket) => Ok(Some(socket)),
                        _ => Err("请先在终端完成 SSH 登录，再打开 Codex 会话。".into()),
                    }
                },
                move || {
                    if let Some(session) = drawer_session.upgrade() {
                        session.toggle_drawer();
                    }
                },
                move || {
                    if let Some(session) = reveal_session.upgrade() {
                        session.show_agent();
                    }
                },
                Rc::new(move |artifact, automatic| {
                    if let Some(session) = preview_session.upgrade()
                        && let Some(preview) = session.preview.upgrade()
                    {
                        preview.offer(&session, artifact, automatic);
                    }
                }),
            );
            let split = gtk::Paned::new(gtk::Orientation::Vertical);
            let drawer = gtk::Box::new(gtk::Orientation::Vertical, 0);
            let tools = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            tools.style_context().add_class("agent-drawer-header");
            tools.pack_start(&gtk::Label::new(Some("终端")), false, false, 0);
            let add = gtk::Button::with_label("加入选区");
            add.style_context().add_class("quiet-button");
            let picker = gtk::ComboBoxText::new();
            picker.style_context().add_class("drawer-picker");
            picker.append(Some("primary"), "终端 1");
            picker.set_active_id(Some("primary"));
            if let Some(accessible) = picker.accessible() {
                accessible.set_name("切换底部终端");
            }
            let close = icons::button(Icon::Close, "关闭底部终端", "关闭当前新增终端");
            close.set_sensitive(false);
            let create = icons::button(
                Icon::Plus,
                "在面板中新建终端",
                match self.launch {
                    Launch::Local => "新建本地终端",
                    Launch::Ssh(_) => "在当前 SSH 主机新建终端",
                },
            );
            for button in [&add, &close, &create] {
                tools.pack_end(button, false, false, 0);
            }
            tools.pack_end(&picker, false, false, 0);
            drawer.pack_start(&tools, false, false, 0);
            let tabs = gtk::Stack::new();
            tabs.set_homogeneous(false);
            drawer.pack_start(&tabs, true, true, 0);
            tabs.show();
            let session = Rc::downgrade(self);
            let target = Rc::downgrade(&agent);
            add.connect_clicked(move |_| {
                if let (Some(session), Some(agent)) = (session.upgrade(), target.upgrade()) {
                    let target = Rc::downgrade(&agent);
                    if !session.active_terminal().request_selection(move |text| {
                        if let Some(agent) = target.upgrade() {
                            if let Some(text) = text.filter(|text| !text.is_empty()) {
                                agent.add_terminal_context(text);
                            } else {
                                agent.show_status("终端选区为空");
                            }
                        }
                    }) {
                        agent.show_status("请先在终端中选中文字");
                    }
                }
            });
            let session = Rc::downgrade(self);
            create.connect_clicked(move |_| {
                if let Some(session) = session.upgrade() {
                    session.add_drawer_shell();
                }
            });
            let session = Rc::downgrade(self);
            close.connect_clicked(move |_| {
                if let Some(session) = session.upgrade() {
                    session.close_drawer_shell();
                }
            });
            let stack = tabs.downgrade();
            let close = close.downgrade();
            picker.connect_changed(move |picker| {
                if let (Some(stack), Some(id)) = (stack.upgrade(), picker.active_id()) {
                    stack.set_visible_child_name(&id);
                    if let Some(close) = close.upgrade() {
                        close.set_sensitive(id != "primary");
                    }
                    if let Some(terminal) = stack_terminal(&stack) {
                        terminal.grab_focus();
                    }
                }
            });
            tools.show_all();
            drawer.set_no_show_all(true);
            split.pack1(&agent.panel, true, false);
            split.pack2(&drawer, false, true);
            self.page.add_named(&split, "agent");
            split.show_all();
            self.agent_view.replace(Some(AgentView {
                split,
                drawer,
                tabs,
                picker,
                next_shell: Cell::new(2),
                extra_shells: RefCell::new(Vec::new()),
            }));
            self.agent.replace(Some(agent));
        }
        self.agent
            .borrow()
            .as_ref()
            .expect("agent initialized")
            .clone()
    }

    pub fn toggle_drawer(&self) {
        if self.page.visible_child_name().as_deref() != Some("agent") {
            return;
        }
        let agent_view = self.agent_view.borrow();
        let Some(view) = agent_view.as_ref() else {
            return;
        };
        if view.drawer.is_visible() {
            view.drawer.hide();
            view.tabs.remove(&self.shell);
            self.page.add_named(&self.shell, "terminal");
            if let Some(agent) = self.agent.borrow().as_ref() {
                agent.focus();
            }
        } else {
            self.page.remove(&self.shell);
            view.tabs.add_named(&self.shell, "primary");
            self.shell.show();
            if let Some(id) = view.picker.active_id() {
                view.tabs.set_visible_child_name(&id);
            }
            view.drawer.show();
            let height = view.split.allocated_height();
            view.split
                .set_position(height.saturating_sub((height / 3).clamp(155, 260)));
            if let Some(terminal) = stack_terminal(&view.tabs) {
                terminal.grab_focus();
            }
        }
    }

    pub fn active_terminal(&self) -> Terminal {
        self.agent_view
            .borrow()
            .as_ref()
            .filter(|view| view.drawer.is_visible())
            .and_then(|view| stack_terminal(&view.tabs))
            .unwrap_or_else(|| self.terminal.clone())
    }

    fn add_drawer_shell(&self) {
        let view = self.agent_view.borrow();
        let Some(view) = view.as_ref() else { return };
        let (terminal, page) = terminal_widget();
        let number = view.next_shell.get();
        view.next_shell.set(number + 1);
        let id = number.to_string();
        let cancellable = gio::Cancellable::new();
        view.tabs.add_named(&page, &id);
        page.show();
        view.extra_shells.borrow_mut().push(Shell {
            id: id.clone(),
            page,
            cancellable: cancellable.clone(),
        });
        view.picker.append(Some(&id), &format!("终端 {number}"));
        view.picker.set_active_id(Some(&id));

        let home = glib::home_dir();
        let control = self.control.borrow();
        let (cwd, argv) = match &self.launch {
            Launch::Local => (home.to_str(), vec!["/bin/bash", "-l"]),
            Launch::Ssh(host) => {
                let mut argv = vec!["/usr/bin/ssh", "-t"];
                if host.trusted_x11 {
                    argv.push("-Y");
                }
                if let Some(path) = control.as_ref().and_then(|socket| socket.path().to_str()) {
                    argv.extend(["-o", "ControlMaster=no", "-S", path]);
                } else if host.trusted_x11 {
                    argv.extend(["-S", "none"]);
                }
                argv.extend(["--", host.target.as_str()]);
                (None, argv)
            }
        };
        terminal.connect_child_exited(|terminal, _| {
            terminal.set_input_enabled(false);
            terminal.feed("\r\n终端已退出。\r\n".as_bytes());
        });
        let target = terminal.downgrade();
        terminal.spawn(cwd, &argv, &cancellable, move |result| {
            if let (Some(terminal), Err(error)) = (target.upgrade(), result) {
                terminal.set_input_enabled(false);
                terminal.feed(format!("\r\n启动失败：{error}\r\n").as_bytes());
            }
        });
    }

    fn close_drawer_shell(&self) {
        let view = self.agent_view.borrow();
        let Some(view) = view.as_ref() else { return };
        let Some(active) = view.picker.active_id() else {
            return;
        };
        let mut shells = view.extra_shells.borrow_mut();
        let Some(index) = shells.iter().position(|shell| shell.id == active.as_str()) else {
            return;
        };
        let old = shells.remove(index);
        let next = index
            .checked_sub(1)
            .map_or("primary", |index| shells[index].id.as_str());
        view.picker.set_active_id(Some(next));
        view.picker.remove((index + 1) as i32);
        old.cancellable.cancel();
        view.tabs.remove(&old.page);
    }

    pub fn focus_terminal(&self) {
        if self.page.visible_child_name().as_deref() == Some("terminal") {
            self.terminal.grab_focus();
        }
    }

    pub fn focus_reconnecting_terminal(&self) {
        let drawer_hidden = self
            .agent_view
            .borrow()
            .as_ref()
            .is_some_and(|view| !view.drawer.is_visible());
        if matches!(self.launch, Launch::Ssh(_)) && drawer_hidden {
            self.toggle_drawer();
        }
        if let Some(view) = self.agent_view.borrow().as_ref() {
            view.picker.set_active_id(Some("primary"));
        }
        self.terminal.grab_focus();
    }

    pub fn file_source(&self) -> Source {
        match self.launch {
            Launch::Local => Source::Local,
            Launch::Ssh(_) => Source::Sftp {
                socket: self
                    .control
                    .borrow()
                    .as_ref()
                    .map(|value| value.path().to_owned()),
            },
        }
    }

    pub fn start(self: &Rc<Self>, changed: impl Fn() + 'static) {
        let home = glib::home_dir();
        if self.control.borrow().is_none() {
            self.control.replace(new_control_socket(&self.launch));
        }
        let socket_path = self
            .control
            .borrow()
            .as_ref()
            .map(|socket| socket.path().to_owned());
        let (cwd, argv) = match &self.launch {
            Launch::Local => (home.to_str(), vec!["/bin/bash", "-l"]),
            Launch::Ssh(host) => {
                let mut argv = vec!["/usr/bin/ssh"];
                if host.trusted_x11 {
                    argv.push("-Y");
                }
                if let Some(path) = socket_path.as_deref().and_then(|path| path.to_str()) {
                    argv.extend(["-M", "-o", "ControlPersist=no", "-S", path]);
                } else if host.trusted_x11 {
                    argv.extend(["-S", "none"]);
                }
                argv.extend(["--", host.target.as_str()]);
                (None, argv)
            }
        };

        if let Some(socket) = socket_path.clone() {
            self.watch_reconnect(socket);
        }
        self.set_state(State::Starting);
        self.terminal.reset(true, false);
        self.terminal.set_input_enabled(true);
        let session = Rc::downgrade(self);
        self.terminal
            .spawn(cwd, &argv, &self.cancellable, move |result| {
                if let Some(session) = session.upgrade() {
                    if session.state.get() != State::Starting || session.cancellable.is_cancelled()
                    {
                        return;
                    }
                    match result {
                        Ok(()) => session.set_state(State::Running),
                        Err(error) => {
                            session.stop_watching();
                            session.control.replace(None);
                            session.set_state(State::Failed);
                            session
                                .terminal
                                .feed(format!("\r\n启动失败：{error}\r\n").as_bytes());
                        }
                    }
                    changed();
                }
            });
    }

    pub fn child_exited(&self, status: i32) {
        self.stop_watching();
        self.control.replace(None);
        if matches!(self.launch, Launch::Ssh(_)) {
            if let Some(agent) = self.agent.borrow().as_ref() {
                agent.disconnect("SSH 已断开。重新连接后可继续 Codex 会话。");
            }
        }
        self.set_state(State::Exited(status));
    }

    pub fn cancel(&self) {
        self.cancellable.cancel();
        if let Some(view) = self.agent_view.borrow().as_ref() {
            for shell in view.extra_shells.take() {
                shell.cancellable.cancel();
                view.tabs.remove(&shell.page);
            }
        }
        self.stop_watching();
        self.agent.take();
    }

    fn watch_reconnect(self: &Rc<Self>, socket: PathBuf) {
        let Some(agent) = self
            .agent
            .borrow()
            .clone()
            .filter(|agent| agent.has_resume())
        else {
            return;
        };
        let Some(parent) = socket.parent() else {
            return;
        };
        let Ok(monitor) = gio::File::for_path(parent)
            .monitor_directory(gio::FileMonitorFlags::NONE, gio::Cancellable::NONE)
        else {
            return;
        };
        let weak = Rc::downgrade(self);
        let check = move || {
            if let Some(session) = weak.upgrade() {
                if crate::sftp::socket_ready(&socket) {
                    session.stop_watching();
                    agent.reconnect();
                }
            }
        };
        let initial = check.clone();
        monitor.connect_changed(move |_, _, _, _| check());
        self.reconnect.replace(Some(monitor));
        initial();
    }

    fn stop_watching(&self) {
        if let Some(monitor) = self.reconnect.take() {
            monitor.cancel();
        }
    }

    fn set_state(&self, state: State) {
        self.state.set(state);
        let style = self.indicator.style_context();
        style.remove_class("session-running");
        style.remove_class("session-failed");
        match state {
            State::Running => style.add_class("session-running"),
            State::Failed => style.add_class("session-failed"),
            State::Exited(status) if status != 0 => style.add_class("session-failed"),
            _ => {}
        }
        if state.can_restart() {
            self.terminal.set_input_enabled(false);
        }
    }
}

fn new_control_socket(launch: &Launch) -> Option<ControlSocket> {
    match launch {
        Launch::Local => None,
        Launch::Ssh(_) => ControlSocket::new(),
    }
}

fn stack_terminal(stack: &gtk::Stack) -> Option<Terminal> {
    stack
        .visible_child()
        .and_downcast::<gtk::ScrolledWindow>()?
        .child()
        .and_downcast()
}

fn terminal_widget() -> (Terminal, gtk::ScrolledWindow) {
    let terminal = Terminal::new();
    terminal.set_scrollback_lines(10_000);
    terminal.apply_theme();
    terminal.set_margin_start(9);
    terminal.set_margin_end(8);
    terminal.set_margin_top(6);
    terminal.set_margin_bottom(4);
    terminal.connect_key_press_event(|terminal, event| {
        let shortcut = gdk::ModifierType::CONTROL_MASK | gdk::ModifierType::SHIFT_MASK;
        let modifiers = event.state();
        if !modifiers.contains(shortcut) || modifiers.contains(gdk::ModifierType::MOD1_MASK) {
            return glib::Propagation::Proceed;
        }
        match event.keyval().to_lower() {
            gdk::keys::constants::c => terminal.copy_text(),
            gdk::keys::constants::v => terminal.paste_text(),
            _ => return glib::Propagation::Proceed,
        }
        glib::Propagation::Stop
    });
    terminal.show();

    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .vscrollbar_policy(gtk::PolicyType::Automatic)
        .overlay_scrolling(true)
        .hexpand(true)
        .vexpand(true)
        .build();
    scroll.style_context().add_class("terminal-page");
    scroll.add(&terminal);
    (terminal, scroll)
}
