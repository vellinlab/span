use crate::{codex_rpc, theme};
use futures::channel::mpsc;
use iced::widget::{
    Space, button, column, container, markdown, row, scrollable, text, text_editor,
};
use iced::{Center, Element, Fill, Right, Task, Theme, clipboard};
use serde_json::{Value, json};
use std::sync::Arc;
use std::{collections::HashMap, path::PathBuf};

#[derive(Clone, Debug)]
pub enum Action {
    Event(codex_rpc::Event),
    New,
    Resume(String),
    More,
    Draft(text_editor::Action),
    Paste,
    Pasted(Option<String>, Option<String>),
    Send,
    Interrupt,
    Copy(String),
    Link(String),
    Toggle(String),
    Approve(Value, bool),
    Retry,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Request {
    Initialize,
    List,
    Open,
    History,
    Start,
    Interrupt,
}

struct Entry {
    id: String,
    title: String,
    folder: String,
}

#[derive(PartialEq, Eq)]
enum Kind {
    User,
    Reply,
    Activity,
}

struct Item {
    id: String,
    kind: Kind,
    title: String,
    value: String,
    parsed: Option<markdown::Content>,
    expanded: bool,
}

struct Approval {
    id: Value,
    detail: String,
}

pub struct Agent {
    connection: Option<mpsc::Sender<Value>>,
    pending: HashMap<u64, Request>,
    request_id: u64,
    catalog: Vec<Entry>,
    thread: Option<String>,
    title: String,
    cwd: Option<PathBuf>,
    cursor: Option<String>,
    items: Vec<Item>,
    draft: text_editor::Content,
    submitted_draft: Option<String>,
    in_flight: bool,
    turn: Option<String>,
    approval: Option<Approval>,
    status: Option<String>,
    copied: Option<String>,
}

impl Agent {
    pub fn new(host: Option<String>, cwd: Option<PathBuf>) -> (Self, Task<Action>) {
        let (connection, events) = codex_rpc::connect(host, cwd.clone());
        let mut agent = Self {
            connection: Some(connection),
            pending: HashMap::new(),
            request_id: 0,
            catalog: Vec::new(),
            thread: None,
            title: String::new(),
            cwd: cwd.clone(),
            cursor: None,
            items: Vec::new(),
            draft: text_editor::Content::new(),
            submitted_draft: None,
            in_flight: false,
            turn: None,
            approval: None,
            status: Some("Connecting to Codex…".into()),
            copied: None,
        };
        agent.request(
            Request::Initialize,
            "initialize",
            json!({
                "clientInfo": {"name":"span", "title":"Span", "version":env!("CARGO_PKG_VERSION")},
                "capabilities":{"experimentalApi":true}
            }),
        );
        (agent, events.map(Action::Event))
    }

    fn send(&mut self, packet: Value) -> bool {
        match self
            .connection
            .as_mut()
            .map(|channel| channel.try_send(packet))
        {
            Some(Ok(())) => true,
            _ => {
                self.status = Some("The Codex connection is unavailable.".into());
                false
            }
        }
    }

    fn request(&mut self, request: Request, method: &str, params: Value) -> bool {
        self.request_id += 1;
        let id = self.request_id;
        if self.send(json!({"id":id, "method":method, "params":params})) {
            self.pending.insert(id, request);
            true
        } else {
            false
        }
    }

    fn load_catalog(&mut self) {
        self.request(
            Request::List,
            "thread/list",
            json!({
                "limit":30,"sortKey":"updated_at","archived":false
            }),
        );
    }

    fn can_open(&self) -> bool {
        self.connection.is_some()
            && !self.in_flight
            && !self
                .pending
                .values()
                .any(|request| matches!(request, Request::Initialize | Request::Open))
    }

    pub fn update(&mut self, action: Action) -> Task<Action> {
        match action {
            Action::Event(codex_rpc::Event::Packet(packet)) => self.packet(packet),
            Action::Event(codex_rpc::Event::Disconnected(reason)) => {
                self.connection = None;
                self.pending.clear();
                self.in_flight = false;
                self.turn = None;
                self.approval = None;
                self.status = Some(reason);
            }
            Action::New if self.can_open() => {
                self.request(Request::Open, "thread/start", json!({
                    "approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write"
                }));
            }
            Action::Resume(id) if self.can_open() => {
                if self.thread.as_deref() != Some(&id) {
                    self.request(
                        Request::Open,
                        "thread/resume",
                        json!({
                            "threadId":id,"excludeTurns":true,
                            "initialTurnsPage":{"limit":4,"sortDirection":"desc","itemsView":"full"}
                        }),
                    );
                }
            }
            Action::More => {
                if let (Some(thread), Some(cursor)) = (&self.thread, &self.cursor)
                    && !self
                        .pending
                        .values()
                        .any(|request| matches!(request, Request::History | Request::Open))
                {
                    self.request(Request::History, "thread/turns/list", json!({
                        "threadId":thread,"cursor":cursor,"limit":8,"sortDirection":"desc","itemsView":"full"
                    }));
                }
            }
            Action::Draft(action) => self.draft.perform(action),
            Action::Paste => {
                if let Some(markdown) = crate::clipboard_markup::from_windows() {
                    self.draft
                        .perform(text_editor::Action::Edit(text_editor::Edit::Paste(
                            Arc::new(markdown),
                        )));
                } else {
                    let thread = self.thread.clone();
                    return clipboard::read().map(move |text| Action::Pasted(thread.clone(), text));
                }
            }
            Action::Pasted(thread, Some(text)) if thread == self.thread => {
                self.draft
                    .perform(text_editor::Action::Edit(text_editor::Edit::Paste(
                        Arc::new(text),
                    )));
            }
            Action::Send => self.send_draft(),
            Action::Interrupt if self.in_flight => {
                if let (Some(thread), Some(turn)) = (&self.thread, &self.turn)
                    && !self
                        .pending
                        .values()
                        .any(|request| *request == Request::Interrupt)
                {
                    self.request(
                        Request::Interrupt,
                        "turn/interrupt",
                        json!({"threadId":thread,"turnId":turn}),
                    );
                }
            }
            Action::Approve(id, agree) => {
                let decision = if agree { "accept" } else { "decline" };
                if self.send(json!({"id":id,"result":{"decision":decision}})) {
                    self.approval = None;
                }
            }
            Action::Copy(id) => {
                if let Some(item) = self.items.iter().find(|item| item.id == id) {
                    self.copied = Some(id);
                    return clipboard::write(item.value.clone());
                }
            }
            Action::Toggle(id) => {
                if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
                    item.expanded = !item.expanded;
                }
            }
            Action::Link(uri) => {
                if (uri.starts_with("https://") || uri.starts_with("http://"))
                    && let Err(error) = open::that_detached(uri)
                {
                    self.status = Some(error.to_string());
                }
            }
            _ => {}
        }
        Task::none()
    }

    fn send_draft(&mut self) {
        let Some(thread) = self.thread.as_deref() else {
            return;
        };
        if self.in_flight
            || self
                .pending
                .values()
                .any(|request| *request == Request::Open)
        {
            return;
        }
        let message = self.draft.text();
        if message.trim().is_empty() {
            return;
        }
        if message.len() > 256 * 1024 {
            self.status = Some("The message exceeds 256 KiB.".into());
            return;
        }
        if self.request(
            Request::Start,
            "turn/start",
            json!({
                "threadId":thread,"summary":"auto",
                "input":[{"type":"text","text":message,"text_elements":[]}]
            }),
        ) {
            self.submitted_draft = Some(message);
            self.in_flight = true;
            self.status = None;
        }
    }

    fn packet(&mut self, packet: Value) {
        if let Some(method) = packet["method"].as_str() {
            if let Some(id) = packet.get("id") {
                self.server_request(method, &packet["params"], id);
            } else {
                self.notification(method, &packet["params"]);
            }
        } else if let Some(request) = packet["id"]
            .as_u64()
            .and_then(|id| self.pending.remove(&id))
        {
            if let Some(error) = packet["error"]["message"].as_str() {
                if request == Request::Start {
                    self.submitted_draft = None;
                    self.in_flight = false;
                }
                self.status = Some(error.into());
                return;
            }
            self.response(request, &packet["result"]);
        }
    }

    fn response(&mut self, request: Request, result: &Value) {
        match request {
            Request::Initialize => {
                if self.send(json!({"method":"initialized"})) {
                    self.status = None;
                    self.load_catalog();
                }
            }
            Request::List => {
                self.catalog = values(&result["data"])
                    .filter_map(|thread| {
                        Some(Entry {
                            id: thread["id"].as_str()?.into(),
                            title: thread_title(thread),
                            folder: thread["cwd"].as_str().unwrap_or_default().into(),
                        })
                    })
                    .collect();
            }
            Request::Open => {
                let thread = &result["thread"];
                let Some(id) = thread["id"].as_str() else {
                    self.status = Some("Codex returned no session ID.".into());
                    return;
                };
                self.thread = Some(id.into());
                self.title = thread_title(thread);
                if let Some(cwd) = result["cwd"].as_str().or_else(|| thread["cwd"].as_str()) {
                    self.cwd = Some(cwd.into());
                }
                self.status = None;
                self.copied = None;
                self.items.clear();
                self.cursor = None;
                if let Some(page) = result
                    .get("initialTurnsPage")
                    .filter(|page| page.is_object())
                {
                    self.history(page);
                } else {
                    for turn in values(&thread["turns"]) {
                        self.history_turn(turn);
                    }
                    if !self.in_flight && thread["turns"].as_array().is_none_or(Vec::is_empty) {
                        self.request(Request::History, "thread/turns/list", json!({
                            "threadId": id, "limit": 4, "sortDirection":"desc","itemsView":"full"
                        }));
                    }
                }
            }
            Request::History => self.history(result),
            Request::Start => {
                if self.submitted_draft.take().as_deref() == Some(&self.draft.text()) {
                    self.draft = text_editor::Content::new();
                }
                self.turn = result["turn"]["id"].as_str().map(str::to_owned);
            }
            Request::Interrupt => {}
        }
    }

    fn history(&mut self, page: &Value) {
        self.cursor = page["nextCursor"].as_str().map(str::to_owned);
        let recent = std::mem::take(&mut self.items);
        if let Some(turns) = page["data"].as_array() {
            for turn in turns.iter().rev() {
                self.history_turn(turn);
            }
        }
        self.items.extend(recent);
    }

    fn history_turn(&mut self, turn: &Value) {
        if turn["status"] == "inProgress" {
            self.turn = turn["id"].as_str().map(str::to_owned);
            self.in_flight = true;
        }
        for item in values(&turn["items"]) {
            self.item(item, true);
        }
    }

    fn server_request(&mut self, method: &str, params: &Value, id: &Value) {
        let same_thread = params["threadId"].as_str() == self.thread.as_deref();
        let supported = matches!(
            method,
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
        );
        if same_thread && supported && self.approval.is_none() {
            let detail = ["command", "reason", "grantRoot"]
                .into_iter()
                .find_map(|key| params[key].as_str())
                .unwrap_or("Codex is requesting permission for an operation.");
            self.approval = Some(Approval {
                id: id.clone(),
                detail: detail.into(),
            });
        } else {
            self.send(json!({"id":id,"error":{"code":-32601,"message":"This client cannot handle this request"}}));
        }
    }

    fn notification(&mut self, method: &str, params: &Value) {
        if self.thread.is_none() || params["threadId"].as_str() != self.thread.as_deref() {
            return;
        }
        match method {
            "turn/started" => {
                self.in_flight = true;
                self.turn = params["turn"]["id"].as_str().map(str::to_owned);
            }
            "turn/completed" => {
                for item in values(&params["turn"]["items"]) {
                    self.item(item, true);
                }
                self.in_flight = false;
                self.turn = None;
                self.approval = None;
                if let Some(error) = params["turn"]["error"]["message"].as_str() {
                    self.status = Some(error.into());
                } else if self.title == "New session" {
                    self.load_catalog();
                }
            }
            "item/started" => self.item(&params["item"], false),
            "item/completed" => self.item(&params["item"], true),
            "item/agentMessage/delta" => {
                if let (Some(id), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    self.upsert(id, Kind::Reply, "", delta, true, false);
                }
            }
            "item/reasoning/summaryTextDelta" => {
                if let (Some(id), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    self.upsert(id, Kind::Activity, "Reasoning summary", delta, true, false);
                }
            }
            "turn/diff/updated" => {
                if let (Some(id), Some(diff)) = (params["turnId"].as_str(), params["diff"].as_str())
                {
                    self.upsert(
                        &format!("{id}-diff"),
                        Kind::Activity,
                        "Changes",
                        diff,
                        false,
                        false,
                    );
                }
            }
            _ => {}
        }
    }

    fn item(&mut self, value: &Value, complete: bool) {
        let Some(id) = value["id"].as_str() else {
            return;
        };
        match value["type"].as_str() {
            Some("userMessage") => {
                let message = values(&value["content"])
                    .filter_map(|item| match item["type"].as_str() {
                        Some("text") => item["text"].as_str(),
                        Some("image" | "localImage") => Some("[Image]"),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !message.trim().is_empty() {
                    self.upsert(id, Kind::User, "", &message, false, false);
                }
            }
            Some("agentMessage" | "plan") => {
                if let Some(message) = value["text"].as_str().filter(|message| !message.is_empty())
                {
                    self.upsert(id, Kind::Reply, "", message, false, complete);
                }
            }
            Some("commandExecution") => {
                let command = value["command"].as_str().unwrap_or("Run command");
                let output = value["aggregatedOutput"].as_str().unwrap_or("");
                self.upsert(id, Kind::Activity, command, output, false, false);
            }
            Some("reasoning") if complete => {
                let text = values(&value["summary"])
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if !text.trim().is_empty() {
                    self.upsert(id, Kind::Activity, "Reasoning summary", &text, false, false);
                }
            }
            _ => {}
        }
    }

    fn upsert(
        &mut self,
        id: &str,
        kind: Kind,
        title: &str,
        value: &str,
        append: bool,
        parse: bool,
    ) {
        let index = self
            .items
            .iter()
            .rposition(|item| item.id == id)
            .unwrap_or_else(|| {
                self.items.push(Item {
                    id: id.into(),
                    kind,
                    title: title.chars().take(220).collect(),
                    value: String::new(),
                    parsed: None,
                    expanded: false,
                });
                self.items.len() - 1
            });
        let item = &mut self.items[index];
        if !append {
            if item.parsed.is_some() && item.value == value {
                return;
            }
            item.value.clear();
        }
        let remaining = (256_usize * 1024).saturating_sub(item.value.len());
        item.value
            .push_str(&value[..value.floor_char_boundary(remaining.min(value.len()))]);
        item.parsed = parse.then(|| markdown::Content::parse(&item.value));
    }

    pub fn artifact_path(&self, action: &Action) -> Option<PathBuf> {
        let Action::Event(codex_rpc::Event::Packet(packet)) = action else {
            return None;
        };
        let params = &packet["params"];
        if packet["method"] != "item/completed"
            || self.thread.is_none()
            || params["threadId"].as_str() != self.thread.as_deref()
        {
            return None;
        }
        let item = &params["item"];
        let path = match item["type"].as_str() {
            Some("imageGeneration") => item["savedPath"].as_str(),
            Some("fileChange") => values(&item["changes"])
                .filter(|change| change["kind"] == "add" || change["kind"]["type"] == "add")
                .filter_map(|change| change["path"].as_str())
                .find(|path| {
                    std::path::Path::new(path)
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| {
                            matches!(
                                ext.to_ascii_lowercase().as_str(),
                                "svg" | "png" | "jpg" | "jpeg" | "md" | "html"
                            )
                        })
                }),
            _ => None,
        }?;
        let file = PathBuf::from(path);
        if file.has_root() {
            Some(file)
        } else {
            Some(self.cwd.as_ref()?.join(file))
        }
    }

    pub fn catalog(&self) -> Element<'_, Action> {
        let mut list = column![].spacing(4);
        for entry in &self.catalog {
            let current = self.thread.as_deref() == Some(&entry.id);
            let mut item = button(
                column![
                    text(&entry.title)
                        .size(14)
                        .wrapping(iced::widget::text::Wrapping::WordOrGlyph),
                    text(&entry.folder)
                        .size(11)
                        .color(theme::MUTED)
                        .wrapping(iced::widget::text::Wrapping::WordOrGlyph),
                ]
                .spacing(3),
            )
            .width(Fill)
            .padding([8, 9])
            .style(move |_, status| theme::tab(current, status));
            if self.can_open() {
                item = item.on_press(Action::Resume(entry.id.clone()));
            }
            list = list.push(item);
        }
        let header = if self.connection.is_some() {
            action("New session", self.can_open().then_some(Action::New), true)
        } else {
            action("Reconnect", Some(Action::Retry), true)
        };
        column![
            text("Codex sessions").size(16).font(theme::SEMIBOLD),
            header,
            scrollable(list).height(Fill),
        ]
        .spacing(12)
        .height(Fill)
        .into()
    }

    pub fn view<'a>(&'a self, theme: &'a Theme) -> Element<'a, Action> {
        if self.thread.is_none() {
            let hint = self
                .status
                .as_deref()
                .unwrap_or("Start a session or open one from the sidebar.");
            return container(
                column![
                    text("Codex").size(28).font(theme::SEMIBOLD),
                    text(hint).size(15).color(theme::MUTED)
                ]
                .spacing(12)
                .align_x(Center),
            )
            .center(Fill)
            .into();
        }
        let mut transcript = column![].spacing(14).width(Fill);
        if self.cursor.is_some() {
            transcript =
                transcript.push(action("Load earlier messages", Some(Action::More), false));
        }
        for item in &self.items {
            let entry = match item.kind {
                Kind::User => container(
                    container(if let Some(parsed) = &item.parsed {
                        markdown::view(
                            parsed.items(),
                            markdown::Settings::with_text_size(15, theme),
                        )
                        .map(Action::Link)
                    } else {
                        text(&item.value).size(15).into()
                    })
                    .padding([10, 14])
                    .max_width(580)
                    .style(|_| theme::rounded(theme::HIGHLIGHT, 14.0)),
                )
                .width(Fill)
                .align_x(Right),
                Kind::Reply => {
                    let response = if let Some(parsed) = &item.parsed {
                        markdown::view(
                            parsed.items(),
                            markdown::Settings::with_text_size(15, theme),
                        )
                        .map(Action::Link)
                    } else {
                        text(&item.value).size(15).into()
                    };
                    let mut body = column![response].spacing(4);
                    if !self.in_flight && item.parsed.is_some() {
                        let label = if self.copied.as_deref() == Some(&item.id) {
                            "Copied"
                        } else {
                            "Copy"
                        };
                        body = body.push(
                            container(action(label, Some(Action::Copy(item.id.clone())), false))
                                .width(Fill)
                                .align_x(Right),
                        );
                    }
                    container(body)
                }
                Kind::Activity => {
                    let label = if item.expanded { "−" } else { "+" };
                    let mut activity = column![action(
                        &format!("{label}  {}", item.title),
                        Some(Action::Toggle(item.id.clone())),
                        false
                    )];
                    if item.expanded {
                        activity = activity.push(
                            container(text(&item.value).size(13).font(iced::Font::MONOSPACE))
                                .padding(12),
                        );
                    }
                    container(activity)
                        .width(Fill)
                        .style(|_| theme::rounded(theme::INSET, 9.0))
                }
            };
            transcript = transcript.push(entry);
        }
        let scroll = scrollable(
            container(container(transcript).width(Fill).max_width(760))
                .padding([20, 24])
                .center_x(Fill),
        )
        .height(Fill)
        .width(Fill)
        .anchor_bottom();
        let editor = text_editor(&self.draft)
            .placeholder("Message Codex")
            .on_action(Action::Draft)
            .height(75)
            .padding(10)
            .size(15)
            .key_binding(|press| {
                let shift = press.modifiers.shift();
                match text_editor::Binding::from_key_press(press)? {
                    text_editor::Binding::Enter if !shift => {
                        Some(text_editor::Binding::Custom(Action::Send))
                    }
                    text_editor::Binding::Paste => {
                        Some(text_editor::Binding::Custom(Action::Paste))
                    }
                    action => Some(action),
                }
            });
        let mut composer = column![].spacing(8);
        if let Some(approval) = &self.approval {
            composer = composer.push(
                column![
                    text("Permission requested").size(14).font(theme::SEMIBOLD),
                    text(&approval.detail).size(13),
                    row![
                        action(
                            "Decline",
                            Some(Action::Approve(approval.id.clone(), false)),
                            false
                        ),
                        action(
                            "Allow once",
                            Some(Action::Approve(approval.id.clone(), true)),
                            true
                        ),
                    ]
                    .spacing(8),
                ]
                .spacing(6),
            );
        }
        if let Some(status) = &self.status {
            composer = composer.push(text(status).size(13).color(theme::MUTED));
        }
        let running = self.in_flight;
        composer = composer.push(editor).push(
            row![
                text(if running { "Working…" } else { "" })
                    .size(13)
                    .color(theme::MUTED),
                Space::new().width(Fill),
                if running {
                    action(
                        "Stop",
                        self.turn.is_some().then_some(Action::Interrupt),
                        false,
                    )
                } else {
                    action(
                        "Send",
                        self.connection.is_some().then_some(Action::Send),
                        true,
                    )
                },
            ]
            .align_y(Center),
        );
        column![
            container(text(&self.title).size(16).font(theme::SEMIBOLD)).padding([10, 23]),
            scroll,
            container(
                container(composer)
                    .padding(11)
                    .width(Fill)
                    .max_width(760)
                    .style(|_| theme::panel(theme::CHROME, 14.0))
            )
            .padding([8, 24])
            .center_x(Fill),
        ]
        .height(Fill)
        .into()
    }
}

fn action<'a>(
    label: impl Into<String>,
    message: Option<Action>,
    accent: bool,
) -> button::Button<'a, Action> {
    button(text(label.into()).size(13))
        .on_press_maybe(message)
        .padding([6, 10])
        .style(move |_, status| theme::button_status(accent, status))
}

fn values(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn thread_title(thread: &Value) -> String {
    ["name", "preview"]
        .into_iter()
        .filter_map(|key| thread[key].as_str())
        .find_map(|value| value.trim().lines().next())
        .unwrap_or("New session")
        .chars()
        .take(160)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_history_and_delta_completion_keep_item_order() {
        let (mut agent, _) = Agent::new(None, None);
        agent.response(
            Request::Open,
            &json!({
                "thread":{"id":"fixture","name":"Fixture"},
                "initialTurnsPage":{"data":[{"id":"stored","items":[
                    {"id":"q","type":"userMessage","content":[{"type":"text","text":"**你好**"}]},
                    {"id":"a","type":"agentMessage","text":"**你好**"}
                ]}]}
            }),
        );
        agent.notification(
            "item/agentMessage/delta",
            &json!({
                "threadId":"other","itemId":"other","delta":"other session"
            }),
        );
        agent.notification(
            "item/agentMessage/delta",
            &json!({
                "threadId":"fixture","itemId":"live","delta":"**新"
            }),
        );
        agent.notification("item/completed", &json!({
            "threadId":"fixture","item":{"id":"live","type":"agentMessage","text":"**新的回复**"}
        }));
        assert_eq!(
            agent
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["q", "a", "live"]
        );
        assert!(agent.items[0].parsed.is_some());
        assert_eq!(agent.items[2].value, "**新的回复**");
        assert!(agent.items[2].parsed.is_some());
    }
}
