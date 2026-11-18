use crate::agent::Agent;
use crate::files::{ControlSocket, Source};
use crate::hosts::Host;
use crate::icons::Icon;
use crate::vte::Terminal;
use gtk::prelude::*;
use gtk::{gdk, gio, glib};
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;

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
    shell: gtk::ScrolledWindow,
    agent_view: RefCell<Option<AgentView>>,
    reconnect: RefCell<Option<gio::FileMonitor>>,
}

struct AgentView {
    split: gtk::Paned,
    drawer: gtk::Box,
}

impl Session {
    pub fn new(launch: Launch) -> Rc<Self> {
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
            );
            let split = gtk::Paned::new(gtk::Orientation::Vertical);
            let drawer = gtk::Box::new(gtk::Orientation::Vertical, 0);
            let tools = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            tools.style_context().add_class("agent-drawer-header");
            tools.pack_start(&gtk::Label::new(Some("终端")), false, false, 0);
            let add = gtk::Button::with_label("加入选区");
            add.style_context().add_class("quiet-button");
            tools.pack_end(&add, false, false, 0);
            drawer.pack_start(&tools, false, false, 0);
            let terminal = self.terminal.downgrade();
            let target = Rc::downgrade(&agent);
            add.connect_clicked(move |_| {
                if let (Some(terminal), Some(agent)) = (terminal.upgrade(), target.upgrade()) {
                    let target = Rc::downgrade(&agent);
                    if !terminal.request_selection(move |text| {
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
            tools.show_all();
            drawer.set_no_show_all(true);
            split.pack1(&agent.panel, true, false);
            split.pack2(&drawer, false, true);
            self.page.add_named(&split, "agent");
            split.show_all();
            self.agent_view.replace(Some(AgentView { split, drawer }));
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
            view.drawer.remove(&self.shell);
            self.page.add_named(&self.shell, "terminal");
            if let Some(agent) = self.agent.borrow().as_ref() {
                agent.focus();
            }
        } else {
            self.page.remove(&self.shell);
            view.drawer.pack_start(&self.shell, true, true, 0);
            self.shell.show();
            view.drawer.show();
            let height = view.split.allocated_height();
            view.split
                .set_position(height.saturating_sub((height / 3).clamp(155, 260)));
            self.terminal.grab_focus();
        }
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
