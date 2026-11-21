use crate::agent_attachments::{self, Attachment, Prepared};
use crate::{agent_execution, agent_settings, codex_rpc, theme};
use futures::channel::mpsc;
use iced::widget::{
    Space, button, column, container, image, keyed_column, markdown, row, scrollable, sensor, svg,
    text, text_editor, tooltip,
};
use iced::{Bottom, Center, Element, Fill, Right, Task, Theme, clipboard};
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

#[derive(Clone, Debug)]
pub enum Action {
    Event(codex_rpc::Event),
    New,
    Resume(String),
    More(u64, String),
    #[cfg(feature = "visual-check")]
    Scrolled(u64, scrollable::Viewport),
    Draft(text_editor::Action),
    Paste,
    AttachImage,
    Prepared(u64, Result<Option<Prepared>, String>),
    RemoveImage(usize),
    Send,
    Interrupt,
    Setting(agent_settings::Change),
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
    Models,
    Start,
    Steer,
    Interrupt,
}

struct Entry {
    id: String,
    title: String,
    folder: String,
}

#[derive(Clone, Copy)]
enum Kind {
    User,
    Reply,
    Activity(Activity),
}

#[derive(Clone, Copy)]
enum Activity {
    Command,
    Reasoning,
    Changes,
}

impl Activity {
    fn icon(self) -> svg::Handle {
        static COMMAND: OnceLock<svg::Handle> = OnceLock::new();
        static REASONING: OnceLock<svg::Handle> = OnceLock::new();
        static CHANGES: OnceLock<svg::Handle> = OnceLock::new();
        let (handle, path) = match self {
            Self::Command => (&COMMAND, "M3 5h18v14H3z M7 9l3 3-3 3m6 0h4"),
            Self::Reasoning => (&REASONING, "M2.5 12h5l3-7 3.5 14 3-7h5"),
            Self::Changes => (&CHANGES, "M6 3h8l4 4v14H6z M9 11h6m-3-3v6m-3 3h6"),
        };
        handle
            .get_or_init(|| svg::Handle::from_memory(format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="{path}" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>"#
            ).into_bytes()))
            .clone()
    }
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
    transcript_id: iced::widget::Id,
    transcript_generation: u64,
    #[cfg(feature = "visual-check")]
    transcript_viewport: Option<scrollable::Viewport>,
    items: Vec<Item>,
    draft: text_editor::Content,
    submitted_draft: Option<String>,
    attachments: Vec<Attachment>,
    preparing: bool,
    in_flight: bool,
    turn: Option<String>,
    approval: Option<Approval>,
    settings: agent_settings::Settings,
    model_provider: Option<String>,
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
            transcript_id: iced::widget::Id::unique(),
            transcript_generation: 0,
            #[cfg(feature = "visual-check")]
            transcript_viewport: None,
            items: Vec::new(),
            draft: text_editor::Content::new(),
            submitted_draft: None,
            attachments: Vec::new(),
            preparing: false,
            in_flight: false,
            turn: None,
            approval: None,
            settings: agent_settings::Settings::default(),
            model_provider: None,
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

    fn load_models(&mut self, cursor: Option<String>) {
        let mut params = json!({"limit":50, "cursor":cursor});
        if let Some(provider) = &self.model_provider {
            params["modelProvider"] = json!(provider);
        }
        self.request(Request::Models, "model/list", params);
    }

    fn can_open(&self) -> bool {
        self.connection.is_some()
            && !self.in_flight
            && !self
                .pending
                .values()
                .any(|request| matches!(request, Request::Initialize | Request::Open))
    }

    fn loading_history(&self) -> bool {
        self.pending
            .values()
            .any(|request| matches!(request, Request::History | Request::Open))
    }

    fn more_history(&mut self) {
        if let (Some(thread), Some(cursor)) = (&self.thread, &self.cursor)
            && !self.loading_history()
        {
            self.request(Request::History, "thread/turns/list", json!({
                "threadId":thread,"cursor":cursor,"limit":8,"sortDirection":"desc","itemsView":"full"
            }));
        }
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
                self.submitted_draft = None;
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
            Action::More(generation, cursor)
                if generation == self.transcript_generation
                    && self.cursor.as_deref() == Some(cursor.as_str()) =>
            {
                self.more_history();
            }
            #[cfg(feature = "visual-check")]
            Action::Scrolled(generation, viewport) if generation == self.transcript_generation => {
                self.transcript_viewport = Some(viewport);
            }
            Action::Draft(action) => self.draft.perform(action),
            Action::Paste if !self.preparing => {
                return self.prepare(agent_attachments::from_clipboard);
            }
            Action::AttachImage if self.can_attach() && !self.preparing => {
                return self.prepare(agent_attachments::pick_file);
            }
            Action::Prepared(generation, result) if generation == self.transcript_generation => {
                self.preparing = false;
                match result {
                    Ok(Some(Prepared::Text(text))) => {
                        self.draft
                            .perform(text_editor::Action::Edit(text_editor::Edit::Paste(
                                Arc::new(text),
                            )));
                    }
                    Ok(Some(Prepared::Image(image))) => self.add_attachment(image),
                    Ok(None) => {}
                    Err(error) => self.status = Some(error),
                }
            }
            Action::RemoveImage(index)
                if self.submitted_draft.is_none() && index < self.attachments.len() =>
            {
                self.attachments.remove(index);
            }
            Action::Send => self.send_draft(),
            Action::Setting(change) => self.settings.change(change),
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

    fn prepare(&mut self, operation: fn() -> Result<Option<Prepared>, String>) -> Task<Action> {
        self.preparing = true;
        let generation = self.transcript_generation;
        Task::perform(
            async move {
                tokio::task::spawn_blocking(operation)
                    .await
                    .unwrap_or_else(|_| Err("Could not prepare the attachment.".into()))
            },
            move |result| Action::Prepared(generation, result),
        )
    }

    fn can_attach(&self) -> bool {
        self.thread.is_some()
            && self.submitted_draft.is_none()
            && self.attachments.len() < agent_attachments::MAX_IMAGES
            && !self
                .pending
                .values()
                .any(|request| *request == Request::Open)
    }

    fn add_attachment(&mut self, attachment: Attachment) {
        if self.thread.is_none() {
            self.status = Some("Open a Codex session before attaching an image.".into());
            return;
        }
        if self.submitted_draft.is_some() {
            self.status = Some("Wait for Codex to accept the current message.".into());
            return;
        }
        if self
            .pending
            .values()
            .any(|request| *request == Request::Open)
        {
            return;
        }
        if self.attachments.len() == agent_attachments::MAX_IMAGES {
            self.status = Some("You can attach up to four images to one message.".into());
            return;
        }
        let bytes = self
            .attachments
            .iter()
            .map(|image| image.bytes)
            .sum::<usize>();
        if bytes + attachment.bytes > agent_attachments::MAX_BYTES {
            self.status = Some("Image attachments are limited to 8 MiB per message.".into());
            return;
        }
        self.attachments.push(attachment);
        self.status = None;
    }

    fn can_send(&self) -> bool {
        self.connection.is_some()
            && self.thread.is_some()
            && self.submitted_draft.is_none()
            && !self.preparing
            && (!self.in_flight || self.turn.is_some())
            && !self
                .pending
                .values()
                .any(|request| matches!(request, Request::Open | Request::Interrupt))
    }

    fn send_draft(&mut self) {
        if !self.can_send() {
            return;
        }
        let Some(thread) = self.thread.as_deref() else {
            return;
        };
        let message = self.draft.text();
        if message.trim().is_empty() && self.attachments.is_empty() {
            return;
        }
        if message.len() > 256 * 1024 {
            self.status = Some("The message exceeds 256 KiB.".into());
            return;
        }
        let mut input = Vec::with_capacity(self.attachments.len() + 1);
        if !message.trim().is_empty() {
            input.push(json!({"type":"text","text":message,"text_elements":[]}));
        }
        input.extend(
            self.attachments
                .iter()
                .map(|image| json!({"type":"image","url":image.url.as_str()})),
        );
        let mut params = json!({"threadId":thread,"input":input});
        let (request, method) = if let Some(turn) = &self.turn {
            params["expectedTurnId"] = json!(turn);
            (Request::Steer, "turn/steer")
        } else {
            params["summary"] = json!("auto");
            self.settings.apply(&mut params);
            (Request::Start, "turn/start")
        };
        if self.request(request, method, params) {
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
                if matches!(request, Request::Start | Request::Steer) {
                    self.submitted_draft = None;
                    if request == Request::Start && self.turn.is_none() {
                        self.in_flight = false;
                    }
                }
                if request != Request::Models {
                    self.status = Some(error.into());
                }
                return;
            }
            self.response(request, &packet["result"]);
        }
    }

    fn response(&mut self, request: Request, result: &Value) {
        match request {
            Request::Initialize => {
                if self.send(json!({"method":"initialized"})) {
                    self.settings.supports_fast = agent_execution::supports_turn_speed(result);
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
                self.attachments.clear();
                self.preparing = false;
                self.cursor = None;
                self.transcript_generation += 1;
                #[cfg(feature = "visual-check")]
                {
                    self.transcript_viewport = None;
                }
                self.pending
                    .retain(|_, request| !matches!(request, Request::History | Request::Models));
                self.settings.open(result);
                self.model_provider = result["modelProvider"].as_str().map(str::to_owned);
                self.load_models(None);
                if let Some(page) = result
                    .get("initialTurnsPage")
                    .filter(|page| page.is_object())
                {
                    self.history(page);
                } else {
                    let existing = HashSet::new();
                    for turn in values(&thread["turns"]) {
                        self.history_turn(turn, true, &existing);
                    }
                    if !self.in_flight && thread["turns"].as_array().is_none_or(Vec::is_empty) {
                        self.request(Request::History, "thread/turns/list", json!({
                            "threadId": id, "limit": 4, "sortDirection":"desc","itemsView":"full"
                        }));
                    }
                }
            }
            Request::History => self.history(result),
            Request::Models => {
                if let Some(cursor) = self.settings.add_page(result) {
                    self.load_models(Some(cursor));
                }
            }
            Request::Start | Request::Steer => {
                if let Some(submitted) = self.submitted_draft.take() {
                    self.attachments.clear();
                    if submitted == self.draft.text() {
                        self.draft = text_editor::Content::new();
                    }
                }
                if request == Request::Start
                    && self.in_flight
                    && let Some(id) = result["turn"]["id"].as_str()
                {
                    self.turn = Some(id.to_owned());
                }
            }
            Request::Interrupt => {}
        }
    }

    fn history(&mut self, page: &Value) {
        let is_older = self.cursor.is_some();
        self.cursor = page["nextCursor"]
            .as_str()
            .filter(|next| !next.is_empty() && self.cursor.as_deref() != Some(*next))
            .map(str::to_owned);
        let recent = std::mem::take(&mut self.items);
        if let Some(turns) = page["data"].as_array() {
            let existing: HashSet<_> = recent.iter().map(|item| item.id.as_str()).collect();
            for turn in turns.iter().rev() {
                self.history_turn(turn, !is_older && self.turn.is_none(), &existing);
            }
        }
        self.items.extend(recent);
    }

    fn history_turn(&mut self, turn: &Value, restore_active: bool, existing: &HashSet<&str>) {
        if restore_active && turn["status"] == "inProgress" {
            self.turn = turn["id"].as_str().map(str::to_owned);
            self.in_flight = true;
        }
        for item in values(&turn["items"]) {
            if item["id"].as_str().is_some_and(|id| !existing.contains(id)) {
                self.item(item, true);
            }
        }
    }

    #[cfg(feature = "visual-check")]
    pub fn visual_probe(&self) -> Option<(iced::widget::Id, scrollable::Viewport, usize, bool)> {
        Some((
            self.transcript_id.clone(),
            self.transcript_viewport?,
            self.items.len(),
            self.cursor.is_some(),
        ))
    }

    #[cfg(feature = "visual-check")]
    pub fn visual_attachment_count(&self) -> usize {
        self.attachments.len()
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
            "thread/tokenUsage/updated" => {
                let usage = &params["tokenUsage"];
                self.settings.context = usage["last"]["totalTokens"].as_u64().zip(
                    usage["modelContextWindow"]
                        .as_u64()
                        .filter(|size| *size > 0),
                );
            }
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
                    self.upsert(
                        id,
                        Kind::Activity(Activity::Reasoning),
                        "Reasoning summary",
                        delta,
                        true,
                        false,
                    );
                }
            }
            "turn/diff/updated" => {
                if let (Some(id), Some(diff)) = (params["turnId"].as_str(), params["diff"].as_str())
                {
                    self.upsert(
                        &format!("{id}-diff"),
                        Kind::Activity(Activity::Changes),
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
                    self.upsert(id, Kind::User, "", &message, false, true);
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
                self.upsert(
                    id,
                    Kind::Activity(Activity::Command),
                    command,
                    output,
                    false,
                    false,
                );
            }
            Some("reasoning") if complete => {
                let text = values(&value["summary"])
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if !text.trim().is_empty() {
                    self.upsert(
                        id,
                        Kind::Activity(Activity::Reasoning),
                        "Reasoning summary",
                        &text,
                        false,
                        true,
                    );
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
        let generation = self.transcript_generation;
        let mut transcript = column![].spacing(12).width(Fill);
        if let Some(cursor) = &self.cursor {
            let loading = self.loading_history();
            let load = action(
                if loading {
                    "Loading history…"
                } else {
                    "Load earlier messages"
                },
                (!loading).then(|| Action::More(generation, cursor.clone())),
                false,
            );
            transcript = transcript.push(
                sensor(load)
                    .key_ref(cursor)
                    .anticipate(150)
                    .on_show(move |_| Action::More(generation, cursor.clone())),
            );
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
                Kind::Activity(kind) => {
                    let toggle = button(
                        row![
                            svg(kind.icon())
                                .width(15)
                                .height(15)
                                .style(|_, _| svg::Style {
                                    color: Some(theme::MUTED),
                                }),
                            text(&item.title).size(13),
                            Space::new().width(Fill),
                            text(if item.expanded { "⌃" } else { "⌄" }).size(15),
                        ]
                        .spacing(8)
                        .align_y(Center),
                    )
                    .on_press(Action::Toggle(item.id.clone()))
                    .width(Fill)
                    .padding([4, 7])
                    .style(move |_, status| theme::tab(item.expanded, status));
                    let mut activity = column![toggle].spacing(5);
                    if item.expanded {
                        let detail: Element<'_, Action> = match kind {
                            Activity::Reasoning => item.parsed.as_ref().map_or_else(
                                || text(&item.value).size(14).into(),
                                |document| {
                                    markdown::view(
                                        document.items(),
                                        markdown::Settings::with_text_size(14, theme),
                                    )
                                    .map(Action::Link)
                                },
                            ),
                            _ => text(&item.value)
                                .size(13)
                                .font(iced::Font::MONOSPACE)
                                .into(),
                        };
                        activity = activity.push(container(detail).padding([7, 14]));
                    }
                    container(activity).width(Fill)
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
        .id(self.transcript_id.clone())
        .direction(scrollable::Direction::Vertical(
            scrollable::Scrollbar::new()
                .width(7)
                .scroller_width(5)
                .margin(2),
        ))
        .anchor_bottom();
        #[cfg(feature = "visual-check")]
        let scroll = scroll.on_scroll(move |viewport| Action::Scrolled(generation, viewport));
        let scroll = keyed_column([(generation, scroll.into())]).height(Fill);
        let editor = text_editor(&self.draft)
            .placeholder("Message Codex")
            .on_action(Action::Draft)
            .height(63)
            .padding([9, 10])
            .size(15)
            .style(theme::editor)
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
        if !self.attachments.is_empty() {
            let mut attachments = row![].spacing(6);
            for (index, attachment) in self.attachments.iter().enumerate() {
                let thumbnail = image(attachment.thumbnail.clone()).width(48).height(32);
                let remove = action(
                    "×",
                    self.submitted_draft
                        .is_none()
                        .then_some(Action::RemoveImage(index)),
                    false,
                );
                let card = row![thumbnail, remove].spacing(4).align_y(Center);
                let card = container(card)
                    .padding([3, 5])
                    .style(|_| theme::panel(theme::INSET, 8.0));
                attachments = attachments.push(tooltip(
                    card,
                    container(text(attachment.name.as_ref()).size(12))
                        .padding(6)
                        .style(|_| theme::panel(theme::CHROME, 6.0)),
                    tooltip::Position::Top,
                ));
            }
            composer = composer.push(attachments);
        }
        let running = self.in_flight;
        let mut controls = row![].spacing(8).align_y(Center);
        if let Some((used, limit)) = self.settings.context {
            let percent = (used as f64 / limit as f64 * 100.0).min(100.0);
            controls = controls.push(tooltip(
                text(format!("Context {percent:.0}%"))
                    .size(12)
                    .color(theme::MUTED),
                container(text(format!("{used} of {limit} context tokens")).size(12))
                    .padding(6)
                    .style(|_| theme::panel(theme::CHROME, 6.0)),
                tooltip::Position::Top,
            ));
        }
        if running {
            controls = controls.push(action(
                "Stop",
                self.turn.is_some().then_some(Action::Interrupt),
                false,
            ));
        }
        controls = controls.push(action(
            if running { "Follow up" } else { "Send" },
            (self.can_send() && (!self.draft.is_empty() || !self.attachments.is_empty()))
                .then_some(Action::Send),
            true,
        ));
        static CLIP: OnceLock<svg::Handle> = OnceLock::new();
        let clip = CLIP.get_or_init(|| {
            svg::Handle::from_memory(
                br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="m20 11-7.5 7.5a4.2 4.2 0 0 1-6-6l8.2-8.2a2.8 2.8 0 0 1 4 4l-8.3 8.3a1.35 1.35 0 0 1-1.9-1.9l7.3-7.3" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>"#
                    .as_slice(),
            )
        });
        let attach = tooltip(
            button(
                svg(clip.clone())
                    .width(15)
                    .height(15)
                    .style(|_, _| svg::Style {
                        color: Some(theme::MUTED),
                    }),
            )
            .padding([6, 7])
            .style(|_, status| theme::button_status(false, status))
            .on_press_maybe((self.can_attach() && !self.preparing).then_some(Action::AttachImage)),
            container(
                text(if self.preparing {
                    "Preparing attachment…"
                } else {
                    "Attach image"
                })
                .size(12),
            )
            .padding(6)
            .style(|_| theme::panel(theme::CHROME, 6.0)),
            tooltip::Position::Top,
        );
        if self.preparing {
            composer = composer.push(text("Preparing attachment…").size(12).color(theme::MUTED));
        }
        composer = composer.push(editor).push(
            row![
                attach,
                container(self.settings.view(running).map(Action::Setting)).width(Fill),
                controls,
            ]
            .spacing(10)
            .align_y(Bottom),
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
    fn image_only_draft_is_kept_on_error_and_released_on_acceptance() {
        let (mut agent, _) = Agent::new(None, None);
        let (sender, mut requests) = mpsc::channel(8);
        agent.connection = Some(sender);
        agent.pending.clear();
        agent.thread = Some("fixture".into());
        let url = "data:image/png;base64,AAAA";
        let screenshot = Attachment {
            name: "Screenshot.png".into(),
            url: Arc::new(url.into()),
            thumbnail: image::Handle::from_rgba(1, 1, vec![255; 4]),
            bytes: 3,
        };
        agent.add_attachment(screenshot.clone());
        agent.send_draft();
        let rejected = requests.try_recv().expect("image-only request");
        assert_eq!(rejected["method"], "turn/start");
        assert_eq!(
            rejected["params"]["input"],
            json!([{"type":"image","url":url}])
        );
        agent.packet(json!({
            "id":rejected["id"],"error":{"message":"Try again"}
        }));
        assert_eq!(agent.attachments.len(), 1);
        agent.send_draft();
        let accepted = requests.try_recv().expect("image-only retry");
        agent.draft = text_editor::Content::with_text("Next draft");
        agent.packet(json!({"id":accepted["id"],"result":{"turn":{"id":"running"}}}));
        assert!(agent.attachments.is_empty());
        assert_eq!(agent.draft.text().trim_end(), "Next draft");
        let _ = agent.update(Action::Prepared(
            agent.transcript_generation + 1,
            Ok(Some(Prepared::Image(screenshot))),
        ));
        assert!(agent.attachments.is_empty());
    }

    #[test]
    fn active_follow_up_does_not_apply_next_turn_settings() {
        let (mut agent, _) = Agent::new(None, None);
        let (sender, mut requests) = mpsc::channel(8);
        agent.connection = Some(sender);
        agent.pending.clear();
        agent.thread = Some("fixture".into());
        agent.turn = Some("running".into());
        agent.in_flight = true;
        agent.settings.supports_fast = true;
        agent.settings.add_page(&json!({
            "data":[{"model":"fixture-model","displayName":"Fixture",
                "supportedReasoningEfforts":[{"reasoningEffort":"high"}],
                "serviceTiers":[{"id":"priority"}]}]
        }));
        for change in [
            agent_settings::Change::Model("fixture-model".into()),
            agent_settings::Change::Effort("high".into()),
            agent_settings::Change::Permission(agent_execution::PermissionMode::ReadOnly),
            agent_settings::Change::Fast,
        ] {
            agent.settings.change(change);
        }
        agent.draft = text_editor::Content::with_text("Follow up");
        agent.send_draft();
        let steer = requests.try_recv().expect("active turn request");
        assert_eq!(steer["method"], "turn/steer");
        assert_eq!(steer["params"]["expectedTurnId"], "running");
        for key in ["model", "effort", "sandboxPolicy", "serviceTierForTurn"] {
            assert!(steer["params"].get(key).is_none());
        }
        agent.packet(json!({
            "id":steer["id"],"error":{"message":"Turn closed before the follow-up"}
        }));
        assert_eq!(agent.draft.text().trim_end(), "Follow up");
        agent.notification(
            "turn/completed",
            &json!({"threadId":"fixture","turn":{"id":"running"}}),
        );
        agent.send_draft();
        let next = requests.try_recv().expect("next turn request");
        assert_eq!(next["method"], "turn/start");
        assert_eq!(next["params"]["model"], "fixture-model");
        assert_eq!(next["params"]["effort"], "high");
        assert_eq!(next["params"]["sandboxPolicy"]["type"], "readOnly");
        assert_eq!(next["params"]["approvalPolicy"], "never");
        assert_eq!(next["params"]["serviceTierForTurn"], "priority");
    }

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
