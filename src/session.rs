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
    pub page: gtk::ScrolledWindow,
    pub terminal: Terminal,
    pub indicator: gtk::Label,
    pub state: Cell<State>,
    pub directory: RefCell<Option<PathBuf>>,
    cancellable: gio::Cancellable,
    control: RefCell<Option<ControlSocket>>,
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

        let page = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .overlay_scrolling(true)
            .hexpand(true)
            .vexpand(true)
            .build();
        page.style_context().add_class("terminal-page");
        page.add(&terminal);

        let indicator = gtk::Label::new(Some("●"));
        indicator.style_context().add_class("session-dot");
        Rc::new(Self {
            launch,
            page,
            terminal,
            indicator,
            state: Cell::new(State::Starting),
            directory: RefCell::new(None),
            cancellable: gio::Cancellable::new(),
            control: RefCell::new(None),
        })
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
        let mut socket_path = None;
        if matches!(self.launch, Launch::Ssh(_)) {
            let socket = ControlSocket::new();
            socket_path = socket.as_ref().map(|value| value.path().to_owned());
            self.control.replace(socket);
        }
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
        self.control.replace(None);
        self.set_state(State::Exited(status));
    }

    pub fn cancel(&self) {
        self.cancellable.cancel();
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
