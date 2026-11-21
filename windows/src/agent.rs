use crate::agent_attachments::{self, Attachment, Prepared};
use crate::{agent_execution, agent_settings, codex_rpc, theme};
use futures::channel::mpsc;
use iced::keyboard::{Key, key::Named};
use iced::widget::{
    Space, button, column, container, image, keyed_column, markdown, row, scrollable, sensor,
    stack, svg, text, text_editor, tooltip,
};
use iced::{Center, Element, Fill, Task, Theme};
use serde_json::{Value, json};
use std::cell::Cell;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};
use uuid::Uuid;

#[path = "agent_activity.rs"]
mod activity;
#[path = "agent_scroll.rs"]
mod agent_scroll;
#[cfg(feature = "visual-check")]
pub(crate) use agent_scroll::PaintedViewport;
#[path = "agent_copy.rs"]
mod copy;
pub(crate) use copy::Format as CopyFormat;
#[path = "agent_goal.rs"]
mod goal;
#[path = "agent_transcript.rs"]
mod transcript;
#[cfg(feature = "visual-check")]
pub(crate) use goal::VisualGoal;

#[derive(Clone, Debug)]
pub enum Action {
    Event(codex_rpc::Event),
    New,
    Resume(String),
    More(u64, String),
    Draft(text_editor::Action),
    GoalSelect(goal::Command),
    GoalAdvance(i8),
    GoalDismiss,
    Paste,
    AttachImage,
    Prepared(Uuid, Result<Option<Prepared>, String>),
    RemoveImage(usize),
    Send,
    Interrupt,
    Setting(agent_settings::Change),
    Copy(String, CopyFormat),
    CopyActivity(String),
    CopyWritten(Uuid, String, CopyFormat, Result<(), String>),
    CopyExpired(Uuid),
    Link(String),
    Toggle(String),
    Approve(Value, bool),
    Retry,
    ToggleTerminalDrawer,
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
    Goal(goal::Pending),
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
    turn_id: Option<String>,
    copy_ready: bool,
    kind: Kind,
    title: String,
    value: String,
    parsed: Option<markdown::Content>,
    expanded: bool,
    measurement: Cell<Option<transcript::Measurement>>,
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
    reading_position: agent_scroll::ReadingPosition,
    items: Vec<Item>,
    composer_id: iced::widget::Id,
    draft: text_editor::Content,
    goals: goal::State,
    submitted_draft: Option<String>,
    attachments: Vec<Attachment>,
    preparing: Option<Uuid>,
    in_flight: bool,
    turn: Option<String>,
    approval: Option<Approval>,
    settings: agent_settings::Settings,
    model_provider: Option<String>,
    status: Option<String>,
    copied: Option<(Uuid, String, CopyFormat)>,
    copy_request: Option<Uuid>,
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
            reading_position: agent_scroll::ReadingPosition::default(),
            items: Vec::new(),
            composer_id: iced::widget::Id::unique(),
            draft: text_editor::Content::new(),
            goals: goal::State::default(),
            submitted_draft: None,
            attachments: Vec::new(),
            preparing: None,
            in_flight: false,
            turn: None,
            approval: None,
            settings: agent_settings::Settings::default(),
            model_provider: None,
            status: Some("Connecting to Codex…".into()),
            copied: None,
            copy_request: None,
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
            Action::Event(codex_rpc::Event::Packet(packet)) => {
                let drafting_goal = self.goals.draft.is_some();
                self.packet(packet);
                if drafting_goal && self.goals.draft.is_none() {
                    return iced::widget::operation::focus(self.composer_id.clone());
                }
            }
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
            Action::Draft(action) => self.edit_composer(action),
            Action::GoalSelect(command) => return self.select_goal(command),
            Action::GoalAdvance(delta) => self.goals.advance(delta),
            Action::GoalDismiss => return self.dismiss_goal(),
            Action::Paste
                if self.preparing.is_none()
                    && !(self.goals.draft.is_some() && self.goal_pending()) =>
            {
                return self.prepare(agent_attachments::from_clipboard);
            }
            Action::AttachImage if self.can_attach() && self.preparing.is_none() => {
                return self.prepare(agent_attachments::pick_file);
            }
            Action::Prepared(id, result) if self.preparing == Some(id) => {
                self.preparing = None;
                match result {
                    Ok(Some(Prepared::Text(text))) => {
                        self.edit_composer(text_editor::Action::Edit(text_editor::Edit::Paste(
                            Arc::new(text),
                        )));
                    }
                    Ok(Some(Prepared::Image(_))) if self.goals.draft.is_some() => {
                        self.status = Some("Session goals accept text.".into());
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
            Action::Send => return self.send_composer(),
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
            Action::Copy(id, format) if self.copy_request.is_none() => {
                if let Some(markdown) = self.turn_markdown(&id) {
                    let request = Uuid::new_v4();
                    self.copy_request = Some(request);
                    return copy::write(markdown, format).map(move |result| {
                        Action::CopyWritten(request, id.clone(), format, result)
                    });
                }
            }
            Action::CopyActivity(id) => {
                if let Some(item) = self
                    .items
                    .iter()
                    .find(|item| item.id == id && matches!(item.kind, Kind::Activity(_)))
                {
                    return iced::clipboard::write(item.value.clone());
                }
            }
            Action::CopyWritten(request, id, format, result)
                if self.copy_request == Some(request) =>
            {
                self.copy_request = None;
                match result {
                    Ok(()) => {
                        self.copied = Some((request, id, format));
                        return Task::perform(
                            async { tokio::time::sleep(Duration::from_millis(1400)).await },
                            move |()| Action::CopyExpired(request),
                        );
                    }
                    Err(error) => self.status = Some(error),
                }
            }
            Action::CopyExpired(request)
                if self
                    .copied
                    .as_ref()
                    .is_some_and(|(active, _, _)| *active == request) =>
            {
                self.copied = None;
            }
            Action::Toggle(id) => {
                if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
                    item.expanded = !item.expanded;
                    item.measurement.set(None);
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

    fn edit_composer(&mut self, action: text_editor::Action) {
        let editing = action.is_edit();
        let goal_pending = self.goal_pending();
        if let Some(goal) = &mut self.goals.draft {
            if !editing || !goal_pending {
                goal.content.perform(action);
            }
        } else {
            self.draft.perform(action);
            if editing {
                self.goals.refresh_suggestions(&self.draft);
            }
        }
    }

    fn prepare(&mut self, operation: fn() -> Result<Option<Prepared>, String>) -> Task<Action> {
        let id = Uuid::new_v4();
        self.preparing = Some(id);
        Task::perform(
            async move {
                tokio::task::spawn_blocking(operation)
                    .await
                    .unwrap_or_else(|_| Err("Could not prepare the attachment.".into()))
            },
            move |result| Action::Prepared(id, result),
        )
    }

    fn can_attach(&self) -> bool {
        self.thread.is_some()
            && self.goals.draft.is_none()
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
            && self.preparing.is_none()
            && (!self.in_flight || self.turn.is_some())
            && !self
                .pending
                .values()
                .any(|request| matches!(request, Request::Open | Request::Interrupt))
    }

    fn send_draft(&mut self, message: String) {
        if !self.can_send() {
            return;
        }
        let Some(thread) = self.thread.as_deref() else {
            return;
        };
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
                if !matches!(
                    request,
                    Request::Models
                        | Request::Goal(goal::Pending {
                            operation: goal::Operation::Refresh,
                            ..
                        })
                ) {
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
                self.copy_request = None;
                self.items.clear();
                self.goals = goal::State::default();
                self.attachments.clear();
                self.preparing = None;
                self.cursor = None;
                self.transcript_generation += 1;
                self.reading_position.clear();
                self.pending.retain(|_, request| {
                    !matches!(
                        request,
                        Request::History | Request::Models | Request::Goal(_)
                    )
                });
                self.refresh_goal(id);
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
            Request::Goal(pending) => self.goal_response(pending, result),
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
        let turn_id = turn["id"].as_str();
        let first_item = self.items.len();
        for item in values(&turn["items"]) {
            if item["id"].as_str().is_some_and(|id| !existing.contains(id)) {
                self.item(item, turn_id, true);
            }
        }
        if turn["status"] != "inProgress"
            && let Some(turn_id) = turn_id
        {
            self.finish_reply(turn_id, first_item);
        }
    }

    #[cfg(feature = "visual-check")]
    pub fn visual_probe(&self) -> Option<(iced::widget::Id, PaintedViewport, usize, bool)> {
        Some((
            self.transcript_id.clone(),
            self.reading_position.painted()?,
            self.items.len(),
            self.cursor.is_some(),
        ))
    }

    #[cfg(feature = "visual-check")]
    pub fn visual_attachment_count(&self) -> usize {
        self.attachments.len()
    }

    #[cfg(feature = "visual-check")]
    pub fn visual_copied(&self, format: CopyFormat) -> bool {
        self.copied
            .as_ref()
            .is_some_and(|(_, _, active)| *active == format)
    }

    #[cfg(feature = "visual-check")]
    pub fn visual_reading_position(&self) -> Option<(String, f32)> {
        self.reading_position.probe()
    }

    #[cfg(feature = "visual-check")]
    pub fn visual_activity_expanded(&self, id: &str) -> bool {
        self.items.iter().any(|item| item.id == id && item.expanded)
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
        let turn_id = params["turnId"].as_str();
        match method {
            "thread/goal/updated" | "thread/goal/cleared" => self.goals.update(&params["goal"]),
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
                let active_turn = self.turn.take();
                let completed_turn = params["turn"]["id"]
                    .as_str()
                    .or(turn_id)
                    .or(active_turn.as_deref());
                for item in values(&params["turn"]["items"]) {
                    self.item(item, completed_turn, true);
                }
                if let Some(id) = completed_turn {
                    self.finish_reply(id, 0);
                }
                self.in_flight = false;
                self.approval = None;
                if let Some(error) = params["turn"]["error"]["message"].as_str() {
                    self.status = Some(error.into());
                } else if self.title == "New session" {
                    self.load_catalog();
                }
            }
            "item/started" => self.item(&params["item"], turn_id, false),
            "item/completed" => self.item(&params["item"], turn_id, true),
            "item/commandExecution/outputDelta" => {
                if let (Some(id), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    self.upsert(
                        id,
                        turn_id,
                        Kind::Activity(Activity::Command),
                        "",
                        delta,
                        true,
                        false,
                    );
                }
            }
            "item/agentMessage/delta" => {
                if let (Some(id), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    self.upsert(id, turn_id, Kind::Reply, "", delta, true, false);
                }
            }
            "item/reasoning/summaryTextDelta" => {
                if let (Some(id), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    self.upsert(
                        id,
                        turn_id,
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
                        Some(id),
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

    fn item(&mut self, value: &Value, turn_id: Option<&str>, complete: bool) {
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
                    self.upsert(id, turn_id, Kind::User, "", &message, false, true);
                }
            }
            Some("agentMessage" | "plan") => {
                if let Some(message) = value["text"].as_str().filter(|message| !message.is_empty())
                {
                    self.upsert(id, turn_id, Kind::Reply, "", message, false, complete);
                }
            }
            Some("commandExecution") => {
                let command = value["command"].as_str().unwrap_or("Run command");
                let output = value["aggregatedOutput"].as_str();
                self.upsert(
                    id,
                    turn_id,
                    Kind::Activity(Activity::Command),
                    command,
                    output.unwrap_or_default(),
                    output.is_none(),
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
                        turn_id,
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

    fn finish_reply(&mut self, turn_id: &str, first_item: usize) {
        let mut last = None;
        let mut has_reply = false;
        for item in self.items[first_item..]
            .iter_mut()
            .filter(|item| item.turn_id.as_deref() == Some(turn_id))
        {
            item.copy_ready = false;
            has_reply |= matches!(item.kind, Kind::Reply) && !item.value.trim().is_empty();
            last = Some(item);
        }
        if let Some(last) = last {
            last.copy_ready = has_reply;
        }
    }

    fn turn_markdown(&self, row_id: &str) -> Option<String> {
        let turn_id = self
            .items
            .iter()
            .find(|item| item.id == row_id && item.copy_ready)?
            .turn_id
            .as_deref()?;
        Some(
            self.items
                .iter()
                .filter(|item| {
                    matches!(item.kind, Kind::Reply) && item.turn_id.as_deref() == Some(turn_id)
                })
                .map(|item| item.value.as_str())
                .filter(|text| !text.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n"),
        )
    }

    fn upsert(
        &mut self,
        id: &str,
        turn_id: Option<&str>,
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
                    turn_id: None,
                    copy_ready: false,
                    kind,
                    title: String::new(),
                    value: String::new(),
                    parsed: None,
                    expanded: false,
                    measurement: Cell::new(None),
                });
                self.items.len() - 1
            });
        let item = &mut self.items[index];
        if item.turn_id.is_none() {
            item.turn_id = turn_id.or(self.turn.as_deref()).map(str::to_owned);
        }
        if !title.is_empty() && item.title != title {
            item.title = title.chars().take(220).collect();
            item.measurement.set(None);
        }
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
        if !matches!(item.kind, Kind::Activity(_)) || item.expanded {
            item.measurement.set(None);
        }
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
        let mut list = column![].spacing(3);
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
            .padding([8, 10])
            .style(move |_, status| theme::tab(current, status));
            if self.can_open() {
                item = item.on_press(Action::Resume(entry.id.clone()));
            }
            list = list.push(item);
        }
        let header = if self.connection.is_some() {
            action("New session", self.can_open().then_some(Action::New), false)
        } else {
            action("Reconnect", Some(Action::Retry), true)
        };
        column![
            text("Codex sessions").size(14).font(theme::SEMIBOLD),
            header,
            scrollable(list).height(Fill),
        ]
        .spacing(12)
        .height(Fill)
        .into()
    }

    pub fn view<'a>(&'a self, theme: &'a Theme, drawer: bool) -> Element<'a, Action> {
        if self.thread.is_none() {
            let hint = self
                .status
                .as_deref()
                .unwrap_or("Start a session or open one from the sidebar.");
            return column![
                self.header("Codex", drawer),
                container(
                    column![
                        text("Codex").size(28).font(theme::SEMIBOLD),
                        text(hint).size(15).color(theme::MUTED)
                    ]
                    .spacing(12)
                    .align_x(Center)
                )
                .center(Fill),
            ]
            .height(Fill)
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
        if !self.items.is_empty() {
            transcript = transcript.push(Element::new(transcript::Transcript::new(
                &self.items,
                theme,
                self.copied
                    .as_ref()
                    .map(|(_, id, format)| (id.as_str(), *format)),
                &self.reading_position,
            )));
        }
        let scroll = scrollable(
            container(container(transcript).width(Fill).max_width(760))
                .padding([agent_scroll::VERTICAL_PADDING, 24])
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
        let scroll = agent_scroll::TranscriptScroll::wrap(
            scroll.into(),
            &self.reading_position,
            &self.items,
        );
        let scroll = keyed_column([(generation, scroll)]).height(Fill);
        let drafting_goal = self.goals.draft.as_ref();
        let menu_open = self.goal_menu_open();
        let scroll: Element<'_, Action> = if menu_open {
            stack![scroll, self.goals.palette()].into()
        } else {
            stack![scroll].into()
        };
        let content = drafting_goal.map_or(&self.draft, |draft| &draft.content);
        let editor = text_editor(content)
            .id(self.composer_id.clone())
            .placeholder(if drafting_goal.is_some() {
                "What should this session accomplish?"
            } else {
                "Message Codex"
            })
            .on_action(Action::Draft)
            .height(56)
            .padding([8, 9])
            .size(theme::BODY_SIZE)
            .line_height(theme::BODY_LEADING)
            .style(theme::editor)
            .key_binding(move |press| {
                let shift = press.modifiers.shift();
                if press.modifiers.is_empty()
                    && matches!(press.status, text_editor::Status::Focused { .. })
                {
                    match press.key.as_ref() {
                        Key::Named(Named::Escape) if menu_open || drafting_goal.is_some() => {
                            return Some(text_editor::Binding::Custom(Action::GoalDismiss));
                        }
                        Key::Named(Named::ArrowUp) if menu_open => {
                            return Some(text_editor::Binding::Custom(Action::GoalAdvance(-1)));
                        }
                        Key::Named(Named::ArrowDown) if menu_open => {
                            return Some(text_editor::Binding::Custom(Action::GoalAdvance(1)));
                        }
                        _ => {}
                    }
                }
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
        if let Some(goal) = self.goals.summary() {
            composer = composer.push(goal);
        }
        if drafting_goal.is_some() {
            composer = composer.push(self.goal_draft_header()).push(editor).push(
                row![
                    Space::new().width(Fill),
                    action(
                        if self.goal_pending() {
                            "Saving…"
                        } else {
                            "Save goal"
                        },
                        (self.can_use_goal() && !content.is_empty()).then_some(Action::Send),
                        true,
                    ),
                ]
                .align_y(Center),
            );
            return self.conversation(scroll, composer, drawer);
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
        let mut controls = row![].spacing(7).align_y(Center);
        if let Some((used, limit)) = self.settings.context {
            controls = controls.push(theme::context_usage(used, limit));
        }
        if running {
            controls = controls.push(theme::ComposerIcon::Stop.button(
                "Stop current response",
                self.turn.is_some().then_some(Action::Interrupt),
            ));
        }
        controls = controls.push(
            theme::ComposerIcon::Send.button(
                if running {
                    "Send follow-up · Enter"
                } else {
                    "Send message · Enter"
                },
                (self.can_send() && (!self.draft.is_empty() || !self.attachments.is_empty()))
                    .then_some(Action::Send),
            ),
        );
        let attach = theme::ComposerIcon::Attach.button(
            if self.preparing.is_some() {
                "Preparing attachment…"
            } else {
                "Attach image"
            },
            (self.can_attach() && self.preparing.is_none()).then_some(Action::AttachImage),
        );
        composer = composer.push(editor).push(
            row![
                row![attach, self.settings.access_control().map(Action::Setting)]
                    .spacing(3)
                    .align_y(Center),
                container(self.settings.view().map(Action::Setting))
                    .width(Fill)
                    .align_x(iced::Right),
                controls,
            ]
            .spacing(7)
            .align_y(Center),
        );
        self.conversation(scroll, composer)
    }

    fn conversation<'a>(
        &'a self,
        scroll: Element<'a, Action>,
        composer: iced::widget::Column<'a, Action>,
        drawer: bool,
    ) -> Element<'a, Action> {
        column![
            self.header(&self.title, drawer),
            scroll,
            container(
                container(composer)
                    .padding(11)
                    .width(Fill)
                    .max_width(760)
                    .style(|_| theme::composer())
            )
            .padding([10, 24])
            .center_x(Fill),
        ]
        .height(Fill)
        .into()
    }

    fn header<'a>(&self, title: &'a str, drawer: bool) -> Element<'a, Action> {
        container(
            row![
                text(title).size(14).font(theme::SEMIBOLD),
                Space::new().width(Fill),
                theme::WorkspaceIcon::Drawer.control(
                    "会话页终端面板 (Ctrl+Shift+J)",
                    Some(Action::ToggleTerminalDrawer),
                    drawer,
                ),
            ]
            .align_y(Center),
        )
        .padding([1, 14])
        .width(Fill)
        .style(|_| theme::surface(theme::WORK))
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
        let _ = agent.update(Action::Send);
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
        let _ = agent.update(Action::Send);
        let accepted = requests.try_recv().expect("image-only retry");
        agent.draft = text_editor::Content::with_text("Next draft");
        agent.packet(json!({"id":accepted["id"],"result":{"turn":{"id":"running"}}}));
        assert!(agent.attachments.is_empty());
        assert_eq!(agent.draft.text().trim_end(), "Next draft");
        let _ = agent.update(Action::Prepared(
            Uuid::new_v4(),
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
        let _ = agent.update(Action::Send);
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
        let _ = agent.update(Action::Send);
        let next = requests.try_recv().expect("next turn request");
        assert_eq!(next["method"], "turn/start");
        assert_eq!(next["params"]["model"], "fixture-model");
        assert_eq!(next["params"]["effort"], "high");
        assert_eq!(next["params"]["sandboxPolicy"]["type"], "readOnly");
        assert_eq!(next["params"]["approvalPolicy"], "never");
        assert_eq!(next["params"]["serviceTierForTurn"], "priority");
    }

    #[test]
    fn command_output_streams_into_one_row_and_keeps_the_final_snapshot() {
        let (mut agent, _) = Agent::new(None, None);
        agent.thread = Some("fixture".into());
        for chunk in ["working\n", "finished\n"] {
            agent.notification(
                "item/commandExecution/outputDelta",
                &json!({
                    "threadId":"fixture","turnId":"round","itemId":"command","delta":chunk
                }),
            );
        }
        agent.notification(
            "item/started",
            &json!({
                "threadId":"fixture","turnId":"round",
                "item":{"id":"command","type":"commandExecution","command":"cargo test"}
            }),
        );
        assert_eq!(agent.items.len(), 1);
        assert_eq!(agent.items[0].title, "cargo test");
        assert_eq!(agent.items[0].value, "working\nfinished\n");

        agent.notification("item/completed", &json!({
            "threadId":"fixture","turnId":"round",
            "item":{"id":"command","type":"commandExecution","command":"cargo test", "aggregatedOutput":"working\nfinished\n16 passed\n"}
        }));
        assert_eq!(agent.items.len(), 1);
        assert_eq!(agent.items[0].value, "working\nfinished\n16 passed\n");
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
            "turn/started",
            &json!({"threadId":"fixture","turn":{"id":"active"}}),
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
        assert!(agent.items[1].copy_ready);
        assert!(!agent.items[2].copy_ready);

        agent.notification(
            "item/completed",
            &json!({
                "threadId":"fixture","turnId":"active",
                "item":{"id":"final","type":"agentMessage","text":"Final answer"}
            }),
        );
        agent.notification(
            "item/completed",
            &json!({
                "threadId":"fixture","turnId":"active",
                "item":{"id":"tool","type":"commandExecution","command":"echo ok"}
            }),
        );
        agent.notification(
            "turn/completed",
            &json!({"threadId":"fixture","turn":{"id":"active","status":"completed"}}),
        );
        assert_eq!(
            agent
                .items
                .iter()
                .filter(|item| item.copy_ready)
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "tool"]
        );
        assert_eq!(
            agent.turn_markdown("tool").as_deref(),
            Some("**新的回复**\n\nFinal answer")
        );
        assert_eq!(agent.turn_markdown("a").as_deref(), Some("**你好**"));
    }
}
