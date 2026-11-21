#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

mod agent;
mod agent_attachments;
#[path = "../../src/agent_execution.rs"]
mod agent_execution;
mod agent_settings;
#[path = "../../src/clipboard_markup.rs"]
#[allow(dead_code)]
mod clipboard_markup;
mod codex_rpc;
mod file_panel;
#[path = "../../src/files.rs"]
#[allow(dead_code)]
mod files;
mod host_panel;
#[path = "../../src/process_environment.rs"]
mod process_environment;
#[path = "../../src/sftp.rs"]
#[allow(dead_code)]
mod sftp;
#[path = "../../src/ssh.rs"]
#[allow(dead_code)]
mod ssh;
#[cfg(test)]
mod ssh_check;
#[path = "../../src/ssh_config.rs"]
mod ssh_config;
mod ssh_destination;
mod terminal;
#[path = "../../src/terminal_theme.rs"]
#[allow(dead_code)]
mod terminal_theme;
mod theme;
#[path = "../../src/unified_diff.rs"]
mod unified_diff;
#[cfg(feature = "visual-check")]
mod visual_check;

use futures::channel::mpsc;
use iced::keyboard::{Key, Modifiers, key::Named};
use iced::widget::{
    Space, button, canvas, column, container, mouse_area, opaque, pin, row, rule, scrollable,
    stack, svg, text, text_input,
};
use iced::{Center, Element, Fill, Size, Task, Theme, clipboard, window};
use std::collections::HashSet;
use std::path::PathBuf;
use terminal::{Clipboard, Notice, Terminal, TerminalId};

const TITLE_PADDING: u32 = 13;
const BRAND_WIDTH: u32 = 89;
const MENU_BUTTON_WIDTH: u32 = 48;

const LOGO: &[u8] =
    include_bytes!("../../packaging/icons/hicolor/scalable/apps/io.github.zyw02.SshWorkbench.svg");

fn main() -> iced::Result {
    let icon =
        image::load_from_memory_with_format(include_bytes!("../span.ico"), image::ImageFormat::Ico)
            .ok()
            .and_then(|image| {
                let width = image.width();
                let height = image.height();
                window::icon::from_rgba(image.into_rgba8().into_raw(), width, height).ok()
            });
    iced::application(Span::boot, Span::update, Span::view)
        .title("Span")
        .settings(iced::Settings {
            default_font: theme::UI_FONT,
            default_text_size: 14.0.into(),
            ..iced::Settings::default()
        })
        .theme(Span::theme)
        .subscription(Span::subscription)
        .window(window::Settings {
            size: Size::new(1216.0, 780.0),
            min_size: Some(Size::new(760.0, 480.0)),
            icon,
            exit_on_close_request: false,
            ..window::Settings::default()
        })
        .run()
}

struct Span {
    theme: Theme,
    logo: svg::Handle,
    terminals: Vec<Tab>,
    active: Option<TerminalId>,
    sidebar: SidebarPage,
    sidebar_visible: bool,
    files_return: SidebarPage,
    next_id: TerminalId,
    events: mpsc::UnboundedSender<Notice>,
    connecting: bool,
    open_menu: Option<WorkspaceMenu>,
    host_input: iced::widget::Id,
    host: String,
    error: Option<String>,
    recent: Vec<String>,
    hosts: host_panel::Panel,
    home: Option<PathBuf>,
    recent_path: Option<PathBuf>,
    #[cfg(feature = "visual-check")]
    visual_check: Option<visual_check::Check>,
}

struct Tab {
    id: TerminalId,
    host: Option<String>,
    host_name: Option<String>,
    terminal: TerminalState,
    agent: Option<agent::Agent>,
    show_agent: bool,
    show_drawer: bool,
    file_panel: Option<file_panel::Panel>,
}

enum TerminalState {
    Opening,
    Ready(Terminal),
    Failed(String),
}

impl Tab {
    fn name(&self) -> &str {
        self.host_name.as_deref().unwrap_or_else(|| {
            self.host
                .as_deref()
                .map_or("PowerShell", ssh_destination::label)
        })
    }

    fn shown_agent(&self) -> Option<&agent::Agent> {
        self.agent.as_ref().filter(|_| self.show_agent)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SidebarPage {
    Hosts,
    Sessions,
    Files,
}

impl SidebarPage {
    const ALL: [Self; 3] = [Self::Hosts, Self::Sessions, Self::Files];

    fn label(self) -> &'static str {
        match self {
            Self::Hosts => "主机",
            Self::Sessions => "会话",
            Self::Files => "文件",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkspaceCommand {
    Local,
    Connect,
    CloseTab,
    AddHost,
    ImportHosts,
    Sidebar,
    Files,
    Agent,
    Catalog,
    Drawer,
    PreviousTab,
    NextTab,
}

impl WorkspaceCommand {
    fn label(self) -> &'static str {
        match self {
            Self::Local => "新建本地终端",
            Self::Connect => "快速连接…",
            Self::CloseTab => "关闭标签",
            Self::AddHost => "添加主机…",
            Self::ImportHosts => "导入 SSH 配置…",
            Self::Sidebar => "显示／隐藏侧栏",
            Self::Files => "文件目录",
            Self::Agent => "Codex 会话／终端",
            Self::Catalog => "Codex 会话列表",
            Self::Drawer => "会话页终端面板",
            Self::PreviousTab => "上一个标签",
            Self::NextTab => "下一个标签",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkspaceMenu {
    Session,
    Host,
    View,
}

impl WorkspaceMenu {
    fn label(self) -> &'static str {
        match self {
            Self::Session => "会话",
            Self::Host => "主机",
            Self::View => "视图",
        }
    }

    fn commands(self) -> &'static [WorkspaceCommand] {
        use WorkspaceCommand::*;
        match self {
            Self::Session => &[Local, Connect, CloseTab],
            Self::Host => &[AddHost, ImportHosts],
            Self::View => &[Sidebar, Files, Agent, Catalog, Drawer, PreviousTab, NextTab],
        }
    }

    fn button(self, selected: Option<Self>) -> Element<'static, Message> {
        theme::mode(
            self.label(),
            Message::ToggleMenu(self),
            selected == Some(self),
        )
        .width(MENU_BUTTON_WIDTH)
        .into()
    }

    fn popup(self) -> Element<'static, Message> {
        let entries =
            column(self.commands().iter().map(|&command| {
                theme::nav(command.label(), Message::Command(command), false).into()
            }))
            .spacing(1);
        let panel = opaque(
            container(entries)
                .width(182)
                .padding(4)
                .style(|_| theme::panel(theme::PANEL, 8.0)),
        );
        let left = TITLE_PADDING + BRAND_WIDTH + self as u32 * MENU_BUTTON_WIDTH;
        stack![
            mouse_area(Space::new().width(Fill).height(Fill)).on_press(Message::DismissPopup),
            pin(panel).x(left as f32).y(2),
        ]
        .into()
    }
}

fn workbench_shortcut(key: Key<&str>, modifiers: Modifiers) -> Option<WorkspaceCommand> {
    use WorkspaceCommand::*;
    if !modifiers.control() || modifiers.alt() || modifiers.logo() {
        return None;
    }
    match (modifiers.shift(), key) {
        (true, Key::Character("t" | "T")) => Some(Local),
        (true, Key::Character("o" | "O")) => Some(Connect),
        (true, Key::Character("w" | "W")) => Some(CloseTab),
        (true, Key::Character("n" | "N")) => Some(AddHost),
        (true, Key::Character("b" | "B")) => Some(Sidebar),
        (true, Key::Character("f" | "F")) => Some(Files),
        (true, Key::Character("a" | "A")) => Some(Agent),
        (true, Key::Character("h" | "H")) => Some(Catalog),
        (true, Key::Character("j" | "J")) => Some(Drawer),
        (false, Key::Named(Named::PageUp)) => Some(PreviousTab),
        (false, Key::Named(Named::PageDown)) => Some(NextTab),
        _ => None,
    }
}

#[derive(Debug, Clone)]
enum Message {
    NewTerminal,
    Command(WorkspaceCommand),
    Sidebar(SidebarPage),
    Files(TerminalId, file_panel::Action),
    Agent(TerminalId, agent::Action),
    Select(TerminalId),
    Close(TerminalId),
    CloseWindow,
    ShowConnect,
    DismissPopup,
    ToggleMenu(WorkspaceMenu),
    ChangeHost(String),
    Connect,
    Hosts(host_panel::Action),
    Terminal(Notice),
    Clipboard(Clipboard),
    Pasted(TerminalId, Option<String>),
    #[cfg(feature = "visual-check")]
    Visual(visual_check::Event),
}

impl Span {
    fn subscription(&self) -> iced::Subscription<Message> {
        let close = window::close_requests().map(|_| Message::CloseWindow);
        let shortcuts = iced::event::listen_with(|event, _, _| {
            let iced::Event::Keyboard(iced::keyboard::Event::KeyPressed { key, modifiers, .. }) =
                event
            else {
                return None;
            };
            (key.as_ref() == Key::Named(Named::Escape) && modifiers.is_empty())
                .then_some(Message::DismissPopup)
                .or_else(|| workbench_shortcut(key.as_ref(), modifiers).map(Message::Command))
        });
        let events = iced::Subscription::batch([close, shortcuts]);
        #[cfg(feature = "visual-check")]
        if self
            .visual_check
            .as_ref()
            .is_some_and(visual_check::Check::measuring)
        {
            return iced::Subscription::batch([events, visual_check::frames()]);
        }
        events
    }

    fn boot() -> (Self, Task<Message>) {
        let (events, receiver) = mpsc::unbounded();
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
        let local_config = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let legacy = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .or_else(|| local_config.clone())
            .map(|path| path.join("ssh-workbench").join("hosts.ini"));
        let config = local_config.map(|path| path.join("Span"));
        #[cfg(feature = "visual-check")]
        let (config, legacy) = std::env::var_os("SPAN_VISUAL_CHECK_DIR")
            .map_or((config, legacy), |path| {
                (Some(PathBuf::from(path).join("profile-fixture")), None)
            });
        let recent_path = config.as_ref().map(|path| path.join("recent-hosts.json"));
        let mut seen = HashSet::new();
        let recent = recent_path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|data| serde_json::from_slice::<Vec<String>>(&data).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|host| ssh_destination::normalize(&host))
            .filter(|host| seen.insert(host.clone()))
            .take(12)
            .collect();
        let mut span = Self {
            theme: theme::make(),
            logo: svg::Handle::from_memory(LOGO),
            terminals: Vec::new(),
            active: None,
            sidebar: SidebarPage::Hosts,
            sidebar_visible: true,
            files_return: SidebarPage::Hosts,
            next_id: 0,
            events,
            connecting: false,
            open_menu: None,
            host_input: iced::widget::Id::unique(),
            host: String::new(),
            error: None,
            recent,
            hosts: host_panel::Panel::new(
                config.map(|path| path.join("hosts.json")),
                legacy.as_deref(),
            ),
            home,
            recent_path,
            #[cfg(feature = "visual-check")]
            visual_check: visual_check::Check::from_env(),
        };
        span.open(None, None);
        let terminal_events = Task::run(receiver, Message::Terminal);
        #[cfg(feature = "visual-check")]
        if span.visual_check.is_some() {
            return (
                span,
                Task::batch([
                    terminal_events,
                    Task::done(Message::Sidebar(SidebarPage::Sessions))
                        .chain(Task::done(Message::Command(WorkspaceCommand::Agent))),
                    visual_check::observe(),
                ]),
            );
        }
        (span, terminal_events)
    }

    fn theme(&self) -> Theme {
        self.theme.clone()
    }

    fn open(&mut self, host: Option<String>, host_name: Option<String>) {
        self.cancel_file_suggestions();
        self.next_id += 1;
        let id = self.next_id;
        let terminal =
            match Terminal::launch(id, host.clone(), self.home.clone(), self.events.clone()) {
                Ok(()) => TerminalState::Opening,
                Err(error) => TerminalState::Failed(error),
            };
        self.error = None;
        self.active = Some(id);
        self.terminals.push(Tab {
            id,
            host,
            host_name,
            terminal,
            agent: None,
            show_agent: false,
            show_drawer: false,
            file_panel: None,
        });
    }

    fn cancel_file_suggestions(&mut self) {
        if self.sidebar != SidebarPage::Files {
            return;
        }
        if let Some(panel) = self
            .terminals
            .iter_mut()
            .find(|tab| self.active == Some(tab.id))
            .and_then(|tab| tab.file_panel.as_mut())
        {
            panel.cancel_suggestions();
        }
    }

    fn connect(&mut self, value: &str) -> Task<Message> {
        let Some(host) = ssh_destination::normalize(value) else {
            self.error = Some("请输入 SSH 别名或 user@host:2222。".into());
            return Task::none();
        };
        self.open(Some(host), None);
        self.connecting = false;
        self.host.clear();
        self.sync_sidebar()
    }

    fn terminal_notice(&mut self, notice: Notice) {
        let id = match &notice {
            Notice::Ready(id, _) | Notice::Event(id, _) => *id,
        };
        let Some(tab) = self.terminals.iter_mut().find(|tab| tab.id == id) else {
            // Dropping an unclaimed PTY requests shutdown on its own thread.
            return;
        };
        match notice {
            Notice::Ready(_, result) if matches!(tab.terminal, TerminalState::Opening) => {
                tab.terminal = match result {
                    Ok(session) => TerminalState::Ready(Terminal::new(session)),
                    Err(error) => TerminalState::Failed(error),
                };
                if matches!(tab.terminal, TerminalState::Ready(_))
                    && let Some(host) = &tab.host
                {
                    self.recent.retain(|entry| entry != host);
                    self.recent.insert(0, host.clone());
                    self.recent.truncate(12);
                    if let Some(path) = self.recent_path.as_deref()
                        && let Err(error) = host_panel::write_json(path, &self.recent)
                    {
                        self.error = Some(format!("Could not save recent connections: {error}"));
                    }
                }
            }
            Notice::Event(_, event) => {
                if let TerminalState::Ready(terminal) = &mut tab.terminal {
                    terminal.event(event);
                }
            }
            _ => {}
        }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        let before = self.visible_terminal_id();
        let task = self.handle_message(message);
        let after = self.visible_terminal_id();
        if before != after {
            for tab in &mut self.terminals {
                let id = Some(tab.id);
                if (id == before || id == after)
                    && let TerminalState::Ready(terminal) = &mut tab.terminal
                {
                    terminal.set_visible(id == after);
                }
            }
        }
        task
    }

    fn visible_terminal_id(&self) -> Option<TerminalId> {
        let tab = self
            .terminals
            .iter()
            .find(|tab| self.active == Some(tab.id))?;
        ((tab.shown_agent().is_none() || tab.show_drawer)
            && matches!(tab.terminal, TerminalState::Ready(_))
            && !self.modal_open())
        .then_some(tab.id)
    }

    fn handle_message(&mut self, message: Message) -> Task<Message> {
        match message {
            #[cfg(feature = "visual-check")]
            Message::Visual(event) => {
                if let Some(check) = &mut self.visual_check {
                    let active = self
                        .terminals
                        .iter()
                        .find(|tab| self.active == Some(tab.id));
                    return check.update(
                        event,
                        active,
                        self.sidebar_visible.then_some(self.sidebar),
                        self.connecting,
                        self.open_menu,
                        self.hosts.dialog_open(),
                    );
                }
            }
            Message::NewTerminal => {
                self.open(None, None);
                return self.sync_sidebar();
            }
            Message::Command(_) if self.modal_open() => {}
            Message::Command(command) => {
                self.open_menu = None;
                return self.run_command(command);
            }
            Message::ToggleMenu(menu) if !self.modal_open() => {
                self.open_menu = (self.open_menu != Some(menu)).then_some(menu);
            }
            Message::ToggleMenu(_) => {}
            Message::Sidebar(page) => return self.show_sidebar(page),
            Message::Files(id, action) => {
                if let Some(panel) = self
                    .terminals
                    .iter_mut()
                    .find(|tab| tab.id == id)
                    .and_then(|tab| tab.file_panel.as_mut())
                {
                    return panel
                        .update(action)
                        .map(move |action| Message::Files(id, action));
                }
            }
            Message::Agent(id, action) => {
                let Some(tab) = self.terminals.iter_mut().find(|tab| tab.id == id) else {
                    return Task::none();
                };
                if matches!(action, agent::Action::Retry) {
                    return start_agent(tab, self.home.clone());
                }
                if matches!(action, agent::Action::ToggleTerminalDrawer) {
                    tab.show_drawer = !tab.show_drawer;
                    return Task::none();
                }
                if matches!(action, agent::Action::New | agent::Action::Resume(_)) {
                    tab.show_agent = true;
                }
                if let Some(agent) = tab.agent.as_mut() {
                    let artifact = (self.active == Some(id) && tab.show_agent)
                        .then(|| agent.artifact_path(&action))
                        .flatten();
                    let event = agent
                        .update(action)
                        .map(move |action| Message::Agent(id, action));
                    if let Some(path) = artifact {
                        if tab.file_panel.is_none() {
                            let (panel, listing) = file_panel::Panel::new(tab.host.clone());
                            tab.file_panel = Some(panel);
                            let preview = tab
                                .file_panel
                                .as_mut()
                                .expect("file panel")
                                .preview_file(path);
                            return Task::batch([
                                event,
                                listing.map(move |action| Message::Files(id, action)),
                                preview.map(move |action| Message::Files(id, action)),
                            ]);
                        }
                        let preview = tab
                            .file_panel
                            .as_mut()
                            .expect("file panel")
                            .preview_file(path);
                        return Task::batch([
                            event,
                            preview.map(move |action| Message::Files(id, action)),
                        ]);
                    }
                    return event;
                }
            }
            Message::CloseWindow => {
                self.terminals.clear();
                self.events.close_channel();
                return iced::exit();
            }
            Message::Select(id) if self.active != Some(id) => {
                self.cancel_file_suggestions();
                self.active = Some(id);
                return self.sync_sidebar();
            }
            Message::Select(_) => {}
            Message::Close(id) => {
                if let Some(position) = self.terminals.iter().position(|tab| tab.id == id) {
                    self.terminals.remove(position);
                    if self.active == Some(id) {
                        self.active = self
                            .terminals
                            .get(position)
                            .or_else(|| self.terminals.last())
                            .map(|tab| tab.id);
                        return self.sync_sidebar();
                    }
                }
            }
            Message::ShowConnect if !self.hosts.dialog_open() => {
                self.open_menu = None;
                self.connecting = !self.connecting;
                self.error = None;
                if self.connecting {
                    return iced::widget::operation::focus(self.host_input.clone());
                }
            }
            Message::ShowConnect => {}
            Message::DismissPopup => {
                self.open_menu = None;
                self.hosts.dismiss();
                if self.connecting {
                    self.connecting = false;
                    self.error = None;
                }
            }
            Message::ChangeHost(host) => {
                self.host = host;
                self.error = None;
            }
            Message::Connect => return self.connect(&self.host.clone()),
            Message::Hosts(host_panel::Action::Connect(host)) => {
                self.open(Some(host.target), Some(host.name));
                return self.sync_sidebar();
            }
            Message::Hosts(host_panel::Action::ConnectRecent(host)) => return self.connect(&host),
            Message::Hosts(action) => return self.host_action(action),
            Message::Terminal(notice) => self.terminal_notice(notice),
            Message::Clipboard(Clipboard::Copy(id)) => {
                if let Some(text) = self.terminal(id).and_then(Terminal::selection) {
                    return clipboard::write(text);
                }
            }
            Message::Clipboard(Clipboard::Paste(id)) => {
                return clipboard::read().map(move |text| Message::Pasted(id, text));
            }
            Message::Pasted(id, text) => {
                if let (Some(terminal), Some(text)) = (self.terminal(id), text) {
                    terminal.paste(text);
                }
            }
        }
        Task::none()
    }

    fn modal_open(&self) -> bool {
        self.connecting || self.hosts.dialog_open()
    }

    fn host_action(&mut self, action: host_panel::Action) -> Task<Message> {
        if !self.connecting {
            return self
                .hosts
                .update(action, self.home.as_deref())
                .map(Message::Hosts);
        }
        Task::none()
    }

    fn show_sidebar(&mut self, page: SidebarPage) -> Task<Message> {
        if self.sidebar != page {
            self.cancel_file_suggestions();
            if page == SidebarPage::Files {
                self.files_return = self.sidebar;
            }
            self.sidebar = page;
        }
        self.sidebar_visible = true;
        self.sync_sidebar()
    }

    fn sync_sidebar(&mut self) -> Task<Message> {
        if !self.sidebar_visible {
            return Task::none();
        }
        let Some(tab) = self
            .terminals
            .iter_mut()
            .find(|tab| Some(tab.id) == self.active)
        else {
            return Task::none();
        };
        match self.sidebar {
            SidebarPage::Sessions if tab.agent.is_none() => start_agent(tab, self.home.clone()),
            SidebarPage::Files if tab.file_panel.is_none() => {
                let (panel, task) = file_panel::Panel::new(tab.host.clone());
                tab.file_panel = Some(panel);
                let id = tab.id;
                task.map(move |action| Message::Files(id, action))
            }
            _ => Task::none(),
        }
    }

    fn run_command(&mut self, command: WorkspaceCommand) -> Task<Message> {
        use WorkspaceCommand::*;
        match command {
            Local => self.handle_message(Message::NewTerminal),
            Connect => self.handle_message(Message::ShowConnect),
            AddHost => self.host_action(host_panel::Action::Add),
            ImportHosts => self.host_action(host_panel::Action::Import),
            CloseTab => self
                .active
                .map_or_else(Task::none, |id| self.handle_message(Message::Close(id))),
            Sidebar => {
                self.sidebar_visible = !self.sidebar_visible;
                if !self.sidebar_visible {
                    self.cancel_file_suggestions();
                }
                self.sync_sidebar()
            }
            Files => self.show_sidebar(
                if self.sidebar_visible && self.sidebar == SidebarPage::Files {
                    self.files_return
                } else {
                    SidebarPage::Files
                },
            ),
            Catalog => self.show_sidebar(SidebarPage::Sessions),
            Agent | Drawer => {
                let Some(tab) = self
                    .terminals
                    .iter_mut()
                    .find(|tab| Some(tab.id) == self.active)
                else {
                    return Task::none();
                };
                if command == Drawer {
                    if tab.show_agent {
                        tab.show_drawer = !tab.show_drawer;
                    }
                } else {
                    tab.show_agent = !tab.show_agent;
                    if tab.show_agent && tab.agent.is_none() {
                        return start_agent(tab, self.home.clone());
                    }
                }
                Task::none()
            }
            PreviousTab | NextTab => {
                let Some(current) = self
                    .terminals
                    .iter()
                    .position(|tab| Some(tab.id) == self.active)
                else {
                    return Task::none();
                };
                let len = self.terminals.len();
                let offset = if command == PreviousTab { len - 1 } else { 1 };
                let id = self.terminals[(current + offset) % len].id;
                self.handle_message(Message::Select(id))
            }
        }
    }

    fn terminal(&self, id: TerminalId) -> Option<&Terminal> {
        match &self.terminals.iter().find(|tab| tab.id == id)?.terminal {
            TerminalState::Ready(terminal) => Some(terminal),
            _ => None,
        }
    }

    fn view(&self) -> Element<'_, Message> {
        use theme::WorkspaceIcon;
        let agent_visible = self.active_tab().is_some_and(|tab| tab.show_agent);
        let chrome = container(
            row![
                container(
                    row![
                        svg(self.logo.clone()).width(28).height(28),
                        text("Span")
                            .size(17)
                            .font(theme::SEMIBOLD)
                            .color(theme::INK),
                    ]
                    .spacing(7)
                    .align_y(Center)
                )
                .width(BRAND_WIDTH),
                WorkspaceMenu::Session.button(self.open_menu),
                WorkspaceMenu::Host.button(self.open_menu),
                WorkspaceMenu::View.button(self.open_menu),
                Space::new().width(Fill),
                WorkspaceIcon::Conversation.control(
                    "Codex 会话／终端 (Ctrl+Shift+A)",
                    self.active
                        .map(|_| Message::Command(WorkspaceCommand::Agent)),
                    agent_visible,
                ),
            ]
            .align_y(Center),
        )
        .padding([6, TITLE_PADDING as u16])
        .width(Fill)
        .style(|_| theme::surface(theme::CHROME));
        let mut body = row![self.rail(), rule::vertical(1).style(theme::rule)].height(Fill);
        if self.sidebar_visible {
            body = body
                .push(self.sidebar())
                .push(rule::vertical(1).style(theme::rule));
        }
        if let Some(tab) = self
            .terminals
            .iter()
            .find(|tab| Some(tab.id) == self.active)
            && let Some(panel) = tab.file_panel.as_ref().filter(|panel| panel.has_preview())
        {
            let id = tab.id;
            body = body
                .push(container(self.workspace()).width(iced::FillPortion(3)))
                .push(rule::vertical(1).style(theme::rule))
                .push(
                    container(
                        panel
                            .view(&self.theme)
                            .map(move |action| Message::Files(id, action)),
                    )
                    .width(iced::FillPortion(2)),
                );
        } else {
            body = body.push(self.workspace());
        }
        let mut body = stack![body].height(Fill);
        if let Some(menu) = self.open_menu {
            body = body.push(menu.popup());
        }
        let workbench = column![chrome, rule::horizontal(1).style(theme::rule), body];
        if self.connecting {
            stack![workbench, self.connect_dialog()].into()
        } else if let Some(dialog) = self.hosts.dialog() {
            stack![workbench, dialog.map(Message::Hosts)].into()
        } else {
            stack![workbench].into()
        }
    }

    fn active_tab(&self) -> Option<&Tab> {
        self.terminals
            .iter()
            .find(|tab| Some(tab.id) == self.active)
    }

    fn rail(&self) -> Element<'_, Message> {
        use theme::WorkspaceIcon;
        container(
            column![
                WorkspaceIcon::Sidebar.control(
                    "显示／隐藏侧栏 (Ctrl+Shift+B)",
                    Some(Message::Command(WorkspaceCommand::Sidebar)),
                    self.sidebar_visible,
                ),
                WorkspaceIcon::Terminal.control(
                    "新建本地终端 (Ctrl+Shift+T)",
                    Some(Message::NewTerminal),
                    false,
                ),
                WorkspaceIcon::Connect.control(
                    "快速连接 (Ctrl+Shift+O)",
                    Some(Message::ShowConnect),
                    self.connecting,
                ),
            ]
            .spacing(5),
        )
        .height(Fill)
        .padding([7, 5])
        .style(|_| theme::surface(theme::CHROME))
        .into()
    }

    fn sidebar(&self) -> Element<'_, Message> {
        let tabs = row(SidebarPage::ALL.into_iter().map(|page| {
            theme::mode(page.label(), Message::Sidebar(page), self.sidebar == page)
                .width(Fill)
                .into()
        }))
        .spacing(3);
        let active = self.active_tab();
        let contents = match self.sidebar {
            SidebarPage::Hosts => self
                .hosts
                .sidebar(&self.recent, active.and_then(|tab| tab.host.as_deref()))
                .map(Message::Hosts),
            SidebarPage::Files => {
                match active.and_then(|tab| Some((tab.id, tab.file_panel.as_ref()?))) {
                    Some((id, panel)) => panel
                        .sidebar()
                        .map(move |action| Message::Files(id, action)),
                    None => text("打开一个本地或 SSH 标签后可浏览文件。")
                        .size(13)
                        .into(),
                }
            }
            SidebarPage::Sessions => {
                match active.and_then(|tab| Some((tab.id, tab.agent.as_ref()?))) {
                    Some((id, agent)) => agent
                        .catalog()
                        .map(move |action| Message::Agent(id, action)),
                    None => text("打开一个标签后可查看 Codex 会话。").size(13).into(),
                }
            }
        };
        container(column![tabs, contents].spacing(12))
            .width(238)
            .height(Fill)
            .padding([10, 12])
            .style(|_| theme::surface(theme::SIDE))
            .into()
    }

    fn connect_dialog(&self) -> Element<'_, Message> {
        let connect = button(text("连接").size(14))
            .on_press_maybe(
                ssh_destination::normalize(&self.host)
                    .is_some()
                    .then_some(Message::Connect),
            )
            .padding([7, 15])
            .style(|_, status| theme::button_status(true, status));
        let mut dialog = column![
            text("快速连接").size(19).font(theme::SEMIBOLD),
            text("SSH 目标").size(13).color(theme::MUTED),
            text_input("SSH 别名或 user@host:port", &self.host)
                .id(self.host_input.clone())
                .on_input(Message::ChangeHost)
                .on_submit(Message::Connect)
                .padding(10)
                .size(14),
        ]
        .spacing(12);
        if let Some(error) = &self.error {
            dialog = dialog.push(text(error).size(13).color(theme::ERROR));
        }
        dialog = dialog.push(
            row![
                Space::new().width(Fill),
                theme::action("取消", Message::DismissPopup, false),
                connect,
            ]
            .align_y(Center)
            .spacing(8),
        );
        opaque(
            container(
                container(dialog)
                    .width(390)
                    .padding(18)
                    .style(|_| theme::panel(theme::PANEL, 12.0)),
            )
            .center(Fill)
            .style(|_| theme::surface(iced::Color::BLACK.scale_alpha(0.48))),
        )
    }

    fn workspace(&self) -> Element<'_, Message> {
        let mut tabs = row![].align_y(Center).spacing(5);
        for tab in &self.terminals {
            use theme::WorkspaceIcon;
            let symbol = if tab.show_agent {
                WorkspaceIcon::Conversation
            } else if tab.host.is_some() {
                WorkspaceIcon::Remote
            } else {
                WorkspaceIcon::Terminal
            };
            let active = self.active == Some(tab.id);
            let state_color = match &tab.terminal {
                TerminalState::Opening => theme::BLUE,
                TerminalState::Ready(terminal) if terminal.exit.is_none() => theme::GREEN,
                TerminalState::Ready(_) => theme::MUTED,
                TerminalState::Failed(_) => theme::ERROR,
            };
            let tab_control = row![
                button(
                    row![
                        symbol.glyph(14, theme::MUTED),
                        text(tab.name()).size(13),
                        container(Space::new().width(7).height(7))
                            .style(move |_| theme::rounded(state_color, 4.0)),
                    ]
                    .spacing(8)
                    .align_y(Center)
                )
                .on_press(Message::Select(tab.id))
                .padding([6, 8])
                .style(move |_, status| theme::tab(active, status)),
                WorkspaceIcon::Close.control(
                    "关闭标签 (Ctrl+Shift+W)",
                    Some(Message::Close(tab.id)),
                    false
                ),
            ]
            .align_y(Center);
            tabs = tabs.push(container(tab_control).style(move |_| {
                theme::rounded(if active { theme::SELECTED } else { theme::WORK }, 8.0)
            }));
        }
        let header = container(
            row![
                scrollable(tabs)
                    .direction(scrollable::Direction::Horizontal(
                        scrollable::Scrollbar::new()
                    ))
                    .width(Fill),
                theme::WorkspaceIcon::Plus.control(
                    "新建本地终端 (Ctrl+Shift+T)",
                    Some(Message::NewTerminal),
                    false,
                ),
            ]
            .spacing(8)
            .align_y(Center),
        )
        .width(Fill)
        .padding([6, 12])
        .style(|_| theme::surface(theme::WORK));
        let content = if let Some(tab) = self.active_tab() {
            if let Some(agent) = tab.shown_agent() {
                let id = tab.id;
                let mut view = column![
                    header,
                    rule::horizontal(1).style(theme::rule),
                    agent
                        .view(&self.theme, tab.show_drawer)
                        .map(move |action| Message::Agent(id, action)),
                ];
                if tab.show_drawer {
                    view = view.push(self.terminal_drawer(tab));
                }
                return view.width(Fill).height(Fill).into();
            }
            match &tab.terminal {
                TerminalState::Ready(terminal) => {
                    let footer = terminal.exit.map_or_else(
                        || match tab.host {
                            Some(_) => "SSH · OpenSSH".into(),
                            None => "Local · ConPTY".into(),
                        },
                        |code| format!("Exited · {code}"),
                    );
                    column![
                        container(self.terminal_surface(terminal))
                            .style(|_| theme::surface(theme::TERMINAL))
                            .height(Fill),
                        rule::horizontal(1).style(theme::rule),
                        container(text(footer).size(12).color(theme::MUTED))
                            .padding([5, 12])
                            .width(Fill)
                            .style(|_| theme::surface(theme::WORK))
                    ]
                }
                TerminalState::Opening => column![
                    container(
                        text(if tab.host.is_some() {
                            "Opening SSH terminal…"
                        } else {
                            "Starting PowerShell…"
                        })
                        .size(14)
                        .color(theme::MUTED)
                    )
                    .center(Fill)
                    .style(|_| theme::surface(theme::TERMINAL))
                ],
                TerminalState::Failed(error) => column![
                    container(
                        column![
                            text("Could not open terminal")
                                .size(18)
                                .font(theme::SEMIBOLD),
                            text(error).size(14).color(theme::ERROR),
                        ]
                        .spacing(8)
                        .align_x(Center)
                    )
                    .padding(24)
                    .center(Fill)
                    .style(|_| theme::surface(theme::TERMINAL))
                ],
            }
        } else {
            column![
                container(
                    column![
                        text("Open a terminal").size(24).font(theme::SEMIBOLD),
                        row![
                            theme::action("PowerShell", Message::NewTerminal, false),
                            theme::action("Connect SSH", Message::ShowConnect, true),
                        ]
                        .spacing(8)
                    ]
                    .spacing(14)
                )
                .center(Fill)
            ]
        };
        let mut work = column![header, rule::horizontal(1).style(theme::rule)];
        if !self.connecting
            && let Some(error) = &self.error
        {
            work = work.push(container(text(error).size(13).color(theme::ERROR)).padding([8, 14]));
        }
        work.push(content.width(Fill).height(Fill))
            .height(Fill)
            .width(Fill)
            .into()
    }

    fn terminal_surface<'a>(&self, terminal: &'a Terminal) -> Element<'a, Message> {
        let terminal: Element<'a, Clipboard> = canvas(terminal).width(Fill).height(Fill).into();
        terminal.map(Message::Clipboard)
    }

    fn terminal_drawer<'a>(&self, tab: &'a Tab) -> Element<'a, Message> {
        let content = match &tab.terminal {
            TerminalState::Ready(terminal) => self.terminal_surface(terminal),
            TerminalState::Opening => container(text("正在启动终端…")).center(Fill).into(),
            TerminalState::Failed(error) => container(text(error).color(theme::ERROR))
                .center(Fill)
                .into(),
        };
        column![
            rule::horizontal(1).style(theme::rule),
            container(
                row![
                    text("终端").size(13).font(theme::SEMIBOLD),
                    Space::new().width(Fill),
                    theme::WorkspaceIcon::Close.control(
                        "关闭终端面板 (Ctrl+Shift+J)",
                        Some(Message::Command(WorkspaceCommand::Drawer)),
                        false,
                    ),
                ]
                .align_y(Center)
            )
            .width(Fill)
            .padding([2, 10])
            .style(|_| theme::surface(theme::CHROME)),
            container(content)
                .height(164)
                .style(|_| theme::surface(theme::TERMINAL)),
        ]
        .into()
    }
}

fn start_agent(tab: &mut Tab, home: Option<PathBuf>) -> Task<Message> {
    let id = tab.id;
    let (agent, events) = agent::Agent::new(tab.host.clone(), home);
    tab.agent = Some(agent);
    events.map(move |action| Message::Agent(id, action))
}
