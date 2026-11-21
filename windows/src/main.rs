#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

mod agent;
#[path = "../../src/agent_execution.rs"]
mod agent_execution;
mod agent_settings;
#[path = "../../src/clipboard_markup.rs"]
mod clipboard_markup;
mod codex_rpc;
mod file_panel;
#[path = "../../src/files.rs"]
#[allow(dead_code)]
mod files;
#[path = "../../src/process_environment.rs"]
mod process_environment;
#[path = "../../src/sftp.rs"]
#[allow(dead_code)]
mod sftp;
#[path = "../../src/ssh.rs"]
#[allow(dead_code)]
mod ssh;
mod terminal;
#[path = "../../src/terminal_theme.rs"]
#[allow(dead_code)]
mod terminal_theme;
mod theme;
#[cfg(feature = "visual-check")]
mod visual_check;

use alacritty_terminal::event::Event;
use futures::channel::mpsc;
use iced::widget::{
    Space, button, canvas, column, container, row, rule, scrollable, svg, text, text_input,
};
use iced::{Center, Element, Fill, Font, Size, Task, Theme, clipboard, window};
use std::path::{Path, PathBuf};
use terminal::{Clipboard, Terminal, TerminalId};

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
        .default_font(Font::with_name("Segoe UI"))
        .theme(Span::theme)
        .subscription(|_| window::close_requests().map(|_| Message::CloseWindow))
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
    sessions: bool,
    show_files: bool,
    next_id: TerminalId,
    events: mpsc::UnboundedSender<(TerminalId, Event)>,
    connecting: bool,
    host: String,
    error: Option<String>,
    recent: Vec<String>,
    home: Option<PathBuf>,
    hosts_path: Option<PathBuf>,
    #[cfg(feature = "visual-check")]
    visual_check: Option<visual_check::Check>,
}

struct Tab {
    id: TerminalId,
    host: Option<String>,
    terminal: Terminal,
    agent: Option<agent::Agent>,
    show_agent: bool,
    file_panel: Option<file_panel::Panel>,
}

impl Tab {
    fn name(&self) -> &str {
        self.host.as_deref().unwrap_or("PowerShell")
    }
}

#[derive(Debug, Clone)]
enum Message {
    NewTerminal,
    ShowTerminal,
    ShowAgent,
    ShowFiles,
    Files(TerminalId, file_panel::Action),
    Agent(TerminalId, agent::Action),
    Select(TerminalId),
    Close(TerminalId),
    CloseWindow,
    ShowConnect,
    ChangeHost(String),
    Connect,
    ConnectRecent(String),
    Pty((TerminalId, Event)),
    Clipboard(Clipboard),
    Pasted(TerminalId, Option<String>),
    #[cfg(feature = "visual-check")]
    Visual(visual_check::Event),
}

impl Span {
    fn boot() -> (Self, Task<Message>) {
        let (events, receiver) = mpsc::unbounded();
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
        let hosts_path = std::env::var_os("LOCALAPPDATA")
            .map(|path| PathBuf::from(path).join("Span").join("recent-hosts.json"));
        let recent = hosts_path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|data| serde_json::from_slice::<Vec<String>>(&data).ok())
            .unwrap_or_default();
        let mut span = Self {
            theme: theme::make(),
            logo: svg::Handle::from_memory(LOGO),
            terminals: Vec::new(),
            active: None,
            sessions: false,
            show_files: false,
            next_id: 0,
            events,
            connecting: false,
            host: String::new(),
            error: None,
            recent,
            home,
            hosts_path,
            #[cfg(feature = "visual-check")]
            visual_check: visual_check::Check::from_env(),
        };
        span.open(None);
        let terminal_events = Task::run(receiver, Message::Pty);
        #[cfg(feature = "visual-check")]
        if span.visual_check.is_some() {
            return (
                span,
                Task::batch([
                    terminal_events,
                    Task::done(Message::ShowAgent),
                    visual_check::observe(),
                ]),
            );
        }
        (span, terminal_events)
    }

    fn theme(&self) -> Theme {
        self.theme.clone()
    }

    fn open(&mut self, host: Option<String>) {
        self.next_id += 1;
        let id = self.next_id;
        let home = self.home.as_deref().filter(|path| path.is_dir());
        match Terminal::open(id, host.as_deref(), home, self.events.clone()) {
            Ok(terminal) => {
                self.error = None;
                self.active = Some(id);
                self.terminals.push(Tab {
                    id,
                    host,
                    terminal,
                    agent: None,
                    show_agent: false,
                    file_panel: None,
                });
                self.sessions = false;
                self.show_files = false;
            }
            Err(error) => self.error = Some(error),
        }
    }

    fn connect(&mut self, value: &str) {
        let host = value.trim();
        if !valid_host(host) {
            self.error = Some("Enter an SSH alias, a hostname or user@host.".into());
            return;
        }
        self.open(Some(host.into()));
        if self.error.is_none() {
            self.connecting = false;
            self.host.clear();
            self.recent.retain(|entry| entry != host);
            self.recent.insert(0, host.into());
            self.recent.truncate(12);
            if let Some(path) = self.hosts_path.as_deref()
                && let Err(error) = save_recent(path, &self.recent)
            {
                self.error = Some(format!("Could not save recent connections: {error}"));
            }
        }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            #[cfg(feature = "visual-check")]
            Message::Visual(event) => {
                if let Some(check) = &mut self.visual_check {
                    let active = self
                        .terminals
                        .iter()
                        .find(|tab| self.active == Some(tab.id));
                    return check.update(event, active);
                }
            }
            Message::NewTerminal => self.open(None),
            Message::ShowTerminal => {
                self.sessions = false;
                self.show_files = false;
                if let Some(tab) = self
                    .terminals
                    .iter_mut()
                    .find(|tab| Some(tab.id) == self.active)
                {
                    tab.show_agent = false;
                }
            }
            Message::ShowAgent => {
                let Some(tab) = self
                    .terminals
                    .iter_mut()
                    .find(|tab| Some(tab.id) == self.active)
                else {
                    return Task::none();
                };
                self.sessions = true;
                self.show_files = false;
                tab.show_agent = true;
                self.connecting = false;
                if tab.agent.is_none() {
                    return start_agent(tab, self.home.clone());
                }
            }
            Message::ShowFiles => {
                let Some(tab) = self
                    .terminals
                    .iter_mut()
                    .find(|tab| Some(tab.id) == self.active)
                else {
                    return Task::none();
                };
                self.sessions = false;
                self.show_files = true;
                self.connecting = false;
                if tab.file_panel.is_none() {
                    let (panel, task) = file_panel::Panel::new(tab.host.clone());
                    tab.file_panel = Some(panel);
                    let id = tab.id;
                    return task.map(move |action| Message::Files(id, action));
                }
            }
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
            Message::Select(id) => {
                self.show_files = false;
                self.active = Some(id);
                self.sessions = self
                    .terminals
                    .iter()
                    .any(|tab| tab.id == id && tab.show_agent);
            }
            Message::Close(id) => {
                if let Some(position) = self.terminals.iter().position(|tab| tab.id == id) {
                    self.terminals.remove(position);
                    if self.active == Some(id) {
                        self.show_files = false;
                        self.active = self
                            .terminals
                            .get(position)
                            .or_else(|| self.terminals.last())
                            .map(|tab| tab.id);
                        self.sessions = self
                            .terminals
                            .iter()
                            .any(|tab| Some(tab.id) == self.active && tab.show_agent);
                    }
                }
            }
            Message::ShowConnect => {
                self.sessions = false;
                self.show_files = false;
                self.connecting = !self.connecting;
                self.error = None;
            }
            Message::ChangeHost(host) => self.host = host,
            Message::Connect => self.connect(&self.host.clone()),
            Message::ConnectRecent(host) => self.connect(&host),
            Message::Pty((id, event)) => {
                if let Some(tab) = self.terminals.iter_mut().find(|tab| tab.id == id) {
                    tab.terminal.event(event);
                }
            }
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

    fn terminal(&self, id: TerminalId) -> Option<&Terminal> {
        self.terminals
            .iter()
            .find(|tab| tab.id == id)
            .map(|tab| &tab.terminal)
    }

    fn view(&self) -> Element<'_, Message> {
        let chrome = container(
            row![
                svg(self.logo.clone()).width(31).height(31),
                text("Span")
                    .size(20)
                    .font(theme::SEMIBOLD)
                    .color(theme::INK),
                Space::new().width(14),
                theme::mode(
                    "Terminal",
                    Message::ShowTerminal,
                    !self.sessions && !self.show_files
                ),
                theme::mode("Codex", Message::ShowAgent, self.sessions),
                theme::mode("Files", Message::ShowFiles, self.show_files),
                Space::new().width(Fill),
                theme::action("Connect SSH", Message::ShowConnect, true),
            ]
            .align_y(Center)
            .spacing(8),
        )
        .padding([9, 18])
        .width(Fill)
        .style(|_| theme::surface(theme::CHROME));
        let mut body = row![self.sidebar(), rule::vertical(1).style(theme::rule)].height(Fill);
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
        column![chrome, rule::horizontal(1).style(theme::rule), body].into()
    }

    fn sidebar(&self) -> Element<'_, Message> {
        if self.show_files
            && let Some(tab) = self
                .terminals
                .iter()
                .find(|tab| Some(tab.id) == self.active)
            && let Some(panel) = &tab.file_panel
        {
            let id = tab.id;
            return container(
                panel
                    .sidebar()
                    .map(move |action| Message::Files(id, action)),
            )
            .width(238)
            .height(Fill)
            .padding([18, 13])
            .style(|_| theme::surface(theme::SIDE))
            .into();
        }
        if self.sessions
            && let Some(tab) = self
                .terminals
                .iter()
                .find(|tab| Some(tab.id) == self.active)
            && let Some(agent) = &tab.agent
        {
            let id = tab.id;
            return container(
                agent
                    .catalog()
                    .map(move |action| Message::Agent(id, action)),
            )
            .width(238)
            .height(Fill)
            .padding([18, 13])
            .style(|_| theme::surface(theme::SIDE))
            .into();
        }
        let mut contents = column![
            text("Connections").size(16).font(theme::SEMIBOLD),
            theme::nav("Local PowerShell", Message::NewTerminal, false),
        ]
        .spacing(10);
        if self.connecting {
            let mut connect = button(text("Connect").size(14))
                .padding([7, 11])
                .style(|_, status| theme::button_status(true, status));
            if valid_host(self.host.trim()) {
                connect = connect.on_press(Message::Connect);
            }
            contents = contents.push(
                container(
                    column![
                        text("SSH destination").size(13).color(theme::MUTED),
                        text_input("alias or user@host", &self.host)
                            .on_input(Message::ChangeHost)
                            .on_submit(Message::Connect)
                            .padding(9)
                            .size(14),
                        connect,
                    ]
                    .spacing(8),
                )
                .padding(10)
                .style(|_| theme::panel(theme::INSET, 10.0)),
            );
        }
        if !self.recent.is_empty() {
            contents = contents.push(text("Recent").size(13).color(theme::MUTED));
            for host in &self.recent {
                let active = self
                    .terminals
                    .iter()
                    .any(|tab| Some(tab.id) == self.active && tab.host.as_ref() == Some(host));
                contents = contents.push(theme::nav(
                    host,
                    Message::ConnectRecent(host.clone()),
                    active,
                ));
            }
        }
        container(scrollable(contents).width(Fill))
            .width(238)
            .height(Fill)
            .padding([18, 13])
            .style(|_| theme::surface(theme::SIDE))
            .into()
    }

    fn workspace(&self) -> Element<'_, Message> {
        let mut tabs = row![].align_y(Center).spacing(5);
        for tab in &self.terminals {
            let active = self.active == Some(tab.id);
            let state_color = if tab.terminal.exit.is_none() {
                theme::GREEN
            } else {
                theme::MUTED
            };
            let tab_control = row![
                button(
                    row![
                        container(Space::new().width(7).height(7))
                            .style(move |_| theme::rounded(state_color, 5.0)),
                        text(tab.name()).size(14),
                    ]
                    .spacing(8)
                    .align_y(Center)
                )
                .on_press(Message::Select(tab.id))
                .padding([6, 8])
                .style(move |_, status| theme::tab(active, status)),
                button(text("×").size(16))
                    .on_press(Message::Close(tab.id))
                    .padding([5, 7])
                    .style(move |_, status| theme::tab(active, status)),
            ]
            .align_y(Center);
            tabs = tabs.push(container(tab_control).style(move |_| {
                theme::rounded(
                    if active {
                        theme::HIGHLIGHT
                    } else {
                        theme::WORK
                    },
                    8.0,
                )
            }));
        }
        let header = container(
            row![
                scrollable(tabs)
                    .direction(scrollable::Direction::Horizontal(
                        scrollable::Scrollbar::new()
                    ))
                    .width(Fill),
                theme::action("＋", Message::NewTerminal, false),
            ]
            .spacing(8)
            .align_y(Center),
        )
        .width(Fill)
        .padding([6, 12])
        .style(|_| theme::surface(theme::WORK));
        let selected = self
            .active
            .and_then(|id| self.terminals.iter().find(|tab| tab.id == id));
        let content = if let Some(tab) = selected {
            if tab.show_agent
                && let Some(agent) = &tab.agent
            {
                let id = tab.id;
                return column![
                    header,
                    rule::horizontal(1).style(theme::rule),
                    agent
                        .view(&self.theme)
                        .map(move |action| Message::Agent(id, action))
                ]
                .width(Fill)
                .height(Fill)
                .into();
            }
            let footer = tab.terminal.exit.map_or_else(
                || match tab.host {
                    Some(_) => "SSH · OpenSSH".into(),
                    None => "Local · ConPTY".into(),
                },
                |code| format!("Exited · {code}"),
            );
            let terminal = canvas(&tab.terminal).width(Fill).height(Fill);
            column![
                container(Element::from(terminal).map(Message::Clipboard))
                    .style(|_| theme::surface(theme::TERMINAL))
                    .height(Fill),
                rule::horizontal(1).style(theme::rule),
                container(text(footer).size(12).color(theme::MUTED))
                    .padding([5, 12])
                    .width(Fill)
                    .style(|_| theme::surface(theme::WORK))
            ]
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
        if let Some(error) = &self.error {
            work = work.push(container(text(error).size(13).color(theme::ERROR)).padding([8, 14]));
        }
        work.push(content.width(Fill).height(Fill))
            .height(Fill)
            .width(Fill)
            .into()
    }
}

fn start_agent(tab: &mut Tab, home: Option<PathBuf>) -> Task<Message> {
    let id = tab.id;
    let (agent, events) = agent::Agent::new(tab.host.clone(), home);
    tab.agent = Some(agent);
    events.map(move |action| Message::Agent(id, action))
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && !host.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn save_recent(path: &Path, recent: &[String]) -> std::io::Result<()> {
    std::fs::create_dir_all(path.parent().expect("configuration parent"))?;
    let pending = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&pending, serde_json::to_vec(recent)?)?;
    if let Err(error) = std::fs::rename(&pending, path) {
        let _ = std::fs::remove_file(pending);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_host;

    #[test]
    fn ssh_destinations_do_not_accept_options() {
        assert!(valid_host("user@build"));
        assert!(valid_host("::1"));
        assert!(!valid_host("-oProxyCommand"));
        assert!(!valid_host("example other"));
    }
}
