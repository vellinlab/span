use crate::agent_catalog::{self, Catalog};
use crate::agent_render::{self, Context};
use crate::agent_rpc::Rpc;
use gtk::prelude::*;
use gtk::{gio, glib, pango};
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

#[derive(Clone, Copy)]
enum Request {
    Initialize { browse: bool },
    Open { resume: bool },
    Catalog(u64),
    Turns { prepend: bool, generation: u64 },
    Unsubscribe,
    Send,
    Interrupt,
}

struct LiveMessage {
    id: String,
    text: String,
    label: gtk::Label,
}

pub struct Agent {
    pub panel: gtk::Box,
    connection: Box<dyn Fn() -> Result<Option<PathBuf>, String>>,
    rpc: RefCell<Option<Rc<Rpc>>>,
    pending: RefCell<HashMap<u64, Request>>,
    thread: RefCell<Option<String>>,
    last_thread: RefCell<Option<String>>,
    turn: RefCell<Option<String>>,
    active: Cell<bool>,
    context: RefCell<Context>,
    approvals: RefCell<HashMap<Value, gtk::Box>>,
    live: RefCell<Option<LiveMessage>>,
    history: gtk::Box,
    older: gtk::Button,
    history_cursor: RefCell<Option<String>>,
    history_generation: Cell<u64>,
    prepend_at: Cell<Option<i32>>,
    opening: Cell<bool>,
    initialized: Cell<bool>,
    list_serial: Cell<u64>,
    catalog_button: gtk::Button,
    catalog: Catalog,
    questions: RefCell<HashMap<Value, gtk::Box>>,
    diff: RefCell<Option<(String, String)>>,
    scroll: gtk::ScrolledWindow,
    status: gtk::Label,
    settings: gtk::Box,
    cwd: gtk::Entry,
    resume: gtk::Entry,
    connect: gtk::Button,
    copy_id: gtk::Button,
    input: gtk::TextView,
    send: gtk::Button,
    stop: gtk::Button,
}

impl Agent {
    pub fn new(
        host: &str,
        initial_directory: Option<&std::path::Path>,
        connection: impl Fn() -> Result<Option<PathBuf>, String> + 'static,
        toggle_terminal: impl Fn() + 'static,
    ) -> Rc<Self> {
        let panel = column(0);
        panel.style_context().add_class("agent-panel");

        let toolbar = row(10);
        toolbar.style_context().add_class("agent-toolbar");
        let title = agent_render::text(&format!("Codex  /  {host}"));
        title.set_selectable(false);
        title.style_context().add_class("agent-title");
        toolbar.pack_start(&title, true, true, 0);
        let terminal = button("终端", false);
        terminal.set_tooltip_text(Some("展开或收起下方终端"));
        terminal.connect_clicked(move |_| toggle_terminal());
        toolbar.pack_end(&terminal, false, false, 0);
        let catalog_button = button("会话", false);
        toolbar.pack_end(&catalog_button, false, false, 0);
        let catalog = Catalog::new(&catalog_button, host);
        let copy_id = button("复制会话 ID", false);
        copy_id.set_no_show_all(true);
        toolbar.pack_end(&copy_id, false, false, 0);
        let status = agent_render::text("等待打开会话");
        status.set_selectable(false);
        status.set_ellipsize(pango::EllipsizeMode::End);
        status.style_context().add_class("agent-status");
        toolbar.pack_end(&status, false, false, 0);
        panel.pack_start(&toolbar, false, false, 0);

        let settings = row(7);
        settings.style_context().add_class("agent-settings");
        let cwd = gtk::Entry::builder()
            .placeholder_text("工作目录（默认登录目录）")
            .width_chars(12)
            .build();
        if let Some(directory) = initial_directory.and_then(|p| p.to_str()) {
            cwd.set_text(directory);
        }
        let resume = gtk::Entry::builder()
            .placeholder_text("会话 ID（留空新建）")
            .width_chars(12)
            .build();
        let connect = button("打开会话", true);
        settings.pack_start(&cwd, true, true, 0);
        settings.pack_start(&resume, true, true, 0);
        settings.pack_end(&connect, false, false, 0);
        panel.pack_start(&settings, false, false, 0);

        let history = column(14);
        history.style_context().add_class("agent-history");
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .build();
        let older = button("加载更早的对话", false);
        older.set_halign(gtk::Align::Start);
        older.set_no_show_all(true);
        history.add(&older);
        scroll.add(&history);
        panel.pack_start(&scroll, true, true, 0);

        let composer = column(5);
        composer.style_context().add_class("agent-composer");
        let input = gtk::TextView::builder()
            .wrap_mode(gtk::WrapMode::WordChar)
            .accepts_tab(false)
            .build();
        let input_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .height_request(77)
            .build();
        input_scroll.add(&input);
        let inputs = row(8);
        let send = button("发送", true);
        send.set_tooltip_text(Some("发送（Ctrl+Enter）"));
        let stop = button("停止", false);
        inputs.pack_end(&send, false, false, 0);
        inputs.pack_end(&stop, false, false, 0);
        composer.pack_start(&input_scroll, false, false, 0);
        composer.pack_end(&inputs, false, false, 0);
        panel.pack_end(&composer, false, false, 0);

        let agent = Rc::new(Self {
            panel,
            connection: Box::new(connection),
            rpc: RefCell::new(None),
            pending: RefCell::new(HashMap::new()),
            thread: RefCell::new(None),
            last_thread: RefCell::new(None),
            turn: RefCell::new(None),
            active: Cell::new(false),
            context: RefCell::new(Context {
                cwd: PathBuf::new(),
                socket: None,
            }),
            approvals: RefCell::new(HashMap::new()),
            live: RefCell::new(None),
            history,
            older,
            history_cursor: RefCell::new(None),
            history_generation: Cell::new(0),
            prepend_at: Cell::new(None),
            opening: Cell::new(false),
            initialized: Cell::new(false),
            list_serial: Cell::new(0),
            catalog_button,
            catalog,
            questions: RefCell::new(HashMap::new()),
            diff: RefCell::new(None),
            scroll,
            status,
            settings,
            cwd,
            resume,
            connect,
            copy_id,
            input,
            send,
            stop,
        });
        agent.bind();
        agent.update_controls();
        agent
    }

    fn bind(self: &Rc<Self>) {
        self.bind_catalog();
        let weak = Rc::downgrade(self);
        self.older.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                if let Some(cursor) = agent.history_cursor.borrow().clone() {
                    agent.older.set_sensitive(false);
                    agent.turn_page(Some(cursor), true);
                }
            }
        });
        let weak = Rc::downgrade(self);
        self.connect.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.open();
            }
        });
        for entry in [&self.cwd, &self.resume] {
            let weak = Rc::downgrade(self);
            entry.connect_activate(move |_| {
                if let Some(agent) = weak.upgrade() {
                    agent.open();
                }
            });
        }
        let weak = Rc::downgrade(self);
        self.send.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.send();
            }
        });
        let weak = Rc::downgrade(self);
        self.stop.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.stop();
            }
        });
        let weak = Rc::downgrade(self);
        self.copy_id.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                if let Some(id) = agent.thread.borrow().as_deref() {
                    agent_render::clipboard().set_text(id);
                }
            }
        });
        let weak = Rc::downgrade(self);
        self.input.connect_key_press_event(move |_, event| {
            use gtk::gdk::keys::constants::{KP_Enter, Return};
            if event.state().contains(gtk::gdk::ModifierType::CONTROL_MASK)
                && matches!(event.keyval(), Return | KP_Enter)
            {
                if let Some(agent) = weak.upgrade() {
                    agent.send();
                }
                glib::Propagation::Stop
            } else {
                glib::Propagation::Proceed
            }
        });
    }

    pub fn focus(&self) {
        if self.thread.borrow().is_some() {
            self.input.grab_focus();
        } else {
            self.cwd.grab_focus();
        }
    }

    fn bind_catalog(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        self.catalog_button.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.show_catalog();
            }
        });
        let weak = Rc::downgrade(self);
        self.catalog.search.connect_search_changed(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.load_catalog(None);
            }
        });
        let weak = Rc::downgrade(self);
        self.catalog.archived.connect_toggled(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.load_catalog(None);
            }
        });
        let weak = Rc::downgrade(self);
        self.catalog.refresh.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.show_catalog();
            }
        });
        let weak = Rc::downgrade(self);
        self.catalog.more.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                if let Some(cursor) = agent.catalog.cursor() {
                    agent.load_catalog(Some(cursor));
                }
            }
        });
        let weak = Rc::downgrade(self);
        self.catalog.on_activate(move |index| {
            if let Some(agent) = weak.upgrade() {
                if let Some(entry) = agent.catalog.entry(index) {
                    if agent.active.get()
                        || agent.opening.get()
                        || !agent.questions.borrow().is_empty()
                    {
                        agent.catalog.show_status("请先结束当前任务或回答提问");
                        return;
                    }
                    agent.catalog.popover.popdown();
                    if agent.thread.borrow().as_deref() != Some(entry.id.as_str()) {
                        agent.resume.set_text(&entry.id);
                        agent.open();
                    } else {
                        agent.settings.hide();
                        agent.focus();
                    }
                }
            }
        });
        let weak = Rc::downgrade(self);
        self.catalog.new_thread.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                if agent.active.get() || agent.opening.get() || !agent.questions.borrow().is_empty()
                {
                    agent.catalog.show_status("请先结束当前任务或回答提问");
                    return;
                }
                agent.catalog.popover.popdown();
                agent.resume.set_text("");
                agent.settings.show();
                agent.cwd.grab_focus();
            }
        });
    }

    pub fn show_catalog(self: &Rc<Self>) {
        self.catalog.popover.popup();
        self.catalog.search.grab_focus();
        if self.initialized.get() {
            self.load_catalog(None);
        } else {
            self.catalog.loading(true);
            self.start_rpc(true);
        }
    }

    fn load_catalog(&self, cursor: Option<String>) {
        if !self.initialized.get() || !self.catalog.popover.is_visible() {
            return;
        }
        let serial = self.list_serial.get() + 1;
        self.list_serial.set(serial);
        self.catalog.loading(cursor.is_none());
        self.request(
            Request::Catalog(serial),
            "thread/list",
            agent_catalog::wire_params(
                &self.catalog.search.text(),
                self.catalog.archived.is_active(),
                cursor,
            ),
        );
    }

    fn open(self: &Rc<Self>) {
        if self.active.get() || self.opening.get() || !self.questions.borrow().is_empty() {
            return;
        }
        if self.initialized.get() {
            self.open_thread();
        } else {
            self.start_rpc(false);
        }
    }

    fn start_rpc(self: &Rc<Self>, browse: bool) {
        if self.rpc.borrow().is_some() {
            return;
        }
        let socket = match (self.connection)() {
            Ok(socket) => socket,
            Err(error) => {
                self.show_status(&error);
                self.catalog.show_status(&error);
                return;
            }
        };
        let weak = Rc::downgrade(self);
        let rpc = match Rpc::start(socket.as_deref(), move |result| {
            if let Some(agent) = weak.upgrade() {
                agent.receive(result);
            }
        }) {
            Ok(rpc) => rpc,
            Err(error) => {
                self.show_status(&error);
                self.catalog.show_status(&error);
                return;
            }
        };
        self.context.borrow_mut().socket = socket;
        self.rpc.replace(Some(rpc));
        self.show_status("正在连接 Codex…");
        self.update_controls();
        self.request(Request::Initialize { browse }, "initialize", json!({
            "clientInfo":{"name":"ssh-workbench","title":"SSH Workbench","version":env!("CARGO_PKG_VERSION")},
            "capabilities":{"experimentalApi":true,"requestAttestation":false}
        }));
    }

    fn open_thread(&self) {
        let resume = self.resume.text();
        let mut params = json!({"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write"});
        let resume_existing = !resume.trim().is_empty();
        let method = if resume_existing {
            params["threadId"] = json!(resume.trim());
            params["excludeTurns"] = json!(true);
            params["initialTurnsPage"] =
                json!({"limit": 12, "sortDirection": "desc", "itemsView":"full"});
            "thread/resume"
        } else {
            let cwd = self.cwd.text();
            if !cwd.trim().is_empty() {
                params["cwd"] = json!(cwd.trim());
            } else if self.context.borrow().socket.is_none() {
                params["cwd"] = json!(glib::home_dir());
            }
            "thread/start"
        };
        self.opening.set(true);
        self.update_controls();
        self.show_status("正在打开会话…");
        self.request(
            Request::Open {
                resume: resume_existing,
            },
            method,
            params,
        );
    }

    fn turn_page(&self, cursor: Option<String>, prepend: bool) {
        if let Some(thread) = self.thread.borrow().as_deref() {
            let generation = self.history_generation.get();
            self.request(Request::Turns { prepend, generation }, "thread/turns/list", json!({
                "threadId":thread,"limit":12,"cursor":cursor,"sortDirection":"desc","itemsView":"full"
            }));
        }
    }

    fn load_turns(&self, data: &Value, newest_first: bool, prepend: bool) {
        let Some(turns) = data.as_array() else { return };
        if prepend {
            self.prepend_at.set(Some(1));
        }
        let mut running = None;
        let turns: Box<dyn Iterator<Item = &Value>> = if newest_first {
            Box::new(turns.iter().rev())
        } else {
            Box::new(turns.iter())
        };
        for turn in turns {
            let mut changes = String::new();
            for item in array(&turn["items"]) {
                self.completed_item(item, true);
                append_file_changes(item, &mut changes);
            }
            if !changes.is_empty() {
                self.add_diff(&changes);
            }
            if turn["status"] == "inProgress" {
                running = turn["id"].as_str().map(str::to_owned);
            }
        }
        self.prepend_at.set(None);
        if !prepend && running.is_some() {
            self.active.set(true);
            self.turn.replace(running);
        }
    }

    fn update_history_cursor(&self, result: &Value) {
        let cursor = result["nextCursor"].as_str().map(str::to_owned);
        self.older.set_visible(cursor.is_some());
        self.older.set_sensitive(cursor.is_some());
        self.history_cursor.replace(cursor);
    }

    pub fn reconnect(self: &Rc<Self>) {
        if self.rpc.borrow().is_none() {
            if let Some(id) = self.last_thread.borrow().as_deref() {
                self.resume.set_text(id);
                self.open();
            }
        }
    }

    pub fn has_resume(&self) -> bool {
        self.last_thread.borrow().is_some()
    }

    pub fn add_terminal_context(&self, selected: &str) {
        if let Some(buffer) = self.input.buffer() {
            let selected = limited(selected, 64 * 1024);
            buffer.insert_at_cursor(&format!("\n\n[终端选区]\n{selected}\n[/终端选区]\n"));
            self.input.grab_focus();
            self.show_status("已加入终端选区");
        }
    }

    fn request(&self, request: Request, method: &str, params: Value) {
        if let Some(rpc) = self.rpc.borrow().as_ref() {
            let id = rpc.request(method, params);
            self.pending.borrow_mut().insert(id, request);
        }
    }

    fn receive(self: &Rc<Self>, event: Result<Value, String>) {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                self.disconnect(&error);
                return;
            }
        };
        if let Some(method) = event["method"].as_str() {
            if !event["id"].is_null() {
                self.server_request(method, event["id"].clone(), &event["params"]);
            } else {
                self.notification(method, &event["params"]);
            }
            return;
        }
        let request = event["id"]
            .as_u64()
            .and_then(|id| self.pending.borrow_mut().remove(&id));
        if let Some(request) = request {
            if let Some(error) = event["error"]["message"].as_str() {
                match request {
                    Request::Initialize { .. } => {
                        self.disconnect(error);
                        self.catalog.show_status(error);
                    }
                    Request::Open { .. } => {
                        self.opening.set(false);
                        self.show_status(error);
                        self.update_controls();
                    }
                    Request::Catalog(serial) if serial == self.list_serial.get() => {
                        self.catalog.show_status(error);
                    }
                    Request::Turns {
                        prepend,
                        generation,
                    } if generation == self.history_generation.get() => {
                        self.older.set_sensitive(prepend);
                        self.show_status(error);
                    }
                    Request::Send => {
                        self.active.set(false);
                        self.show_status(error);
                        self.update_controls();
                    }
                    Request::Interrupt => {
                        self.show_status(error);
                        self.update_controls();
                    }
                    _ => {}
                }
            } else {
                self.response(request, &event["result"]);
            }
        }
    }

    fn response(&self, request: Request, result: &Value) {
        match request {
            Request::Initialize { browse } => {
                if let Some(rpc) = self.rpc.borrow().as_ref() {
                    rpc.notify("initialized");
                }
                self.initialized.set(true);
                self.update_controls();
                if browse {
                    self.load_catalog(None);
                    self.show_status("选择会话或新建");
                } else {
                    self.open_thread();
                }
            }
            Request::Open { resume } => {
                self.opening.set(false);
                let thread = &result["thread"];
                let Some(id) = thread["id"].as_str() else {
                    self.show_status("Codex 未返回会话 ID。");
                    self.update_controls();
                    return;
                };
                let previous = self.thread.replace(Some(id.to_owned()));
                self.last_thread.replace(Some(id.to_owned()));
                if let Some(previous) = previous.filter(|previous| previous != id) {
                    self.request(
                        Request::Unsubscribe,
                        "thread/unsubscribe",
                        json!({"threadId":previous}),
                    );
                }
                self.resume.set_text(id);
                if let Some(cwd) = result["cwd"].as_str().or_else(|| thread["cwd"].as_str()) {
                    self.context.borrow_mut().cwd = PathBuf::from(cwd);
                    self.cwd.set_text(&cwd.replace('\0', "�"));
                }
                self.clear_history();
                self.active.set(false);
                self.turn.take();
                if let Some(page) = result
                    .get("initialTurnsPage")
                    .filter(|page| page.is_object())
                {
                    self.load_turns(&page["data"], true, false);
                    self.update_history_cursor(page);
                } else if thread["turns"]
                    .as_array()
                    .is_some_and(|turns| !turns.is_empty())
                {
                    self.load_turns(&thread["turns"], false, false);
                } else if resume {
                    self.turn_page(None, false);
                }
                self.settings.hide();
                self.copy_id.show();
                self.show_status(result["model"].as_str().unwrap_or("就绪"));
                self.update_controls();
                self.input.grab_focus();
            }
            Request::Catalog(serial) => {
                if serial == self.list_serial.get() {
                    self.catalog.update(result);
                }
            }
            Request::Turns {
                prepend,
                generation,
            } => {
                if generation == self.history_generation.get() {
                    self.load_turns(&result["data"], true, prepend || self.active.get());
                    self.update_history_cursor(result);
                    self.update_controls();
                }
            }
            Request::Unsubscribe => {}
            Request::Send => {
                if self.active.get() {
                    self.turn
                        .replace(result["turn"]["id"].as_str().map(str::to_owned));
                }
                self.update_controls();
            }
            Request::Interrupt => {}
        }
    }

    fn send(&self) {
        if self.active.get() || self.opening.get() {
            return;
        }
        let Some(thread) = self.thread.borrow().clone() else {
            return;
        };
        let Some(buffer) = self.input.buffer() else {
            return;
        };
        let Some(text) = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false) else {
            return;
        };
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        if text.len() > 256 * 1024 {
            self.show_status("输入超过 256 KiB。");
            return;
        }
        self.add_user(text);
        buffer.set_text("");
        self.active.set(true);
        self.show_status("Codex 正在处理…");
        self.update_controls();
        self.request(
            Request::Send,
            "turn/start",
            json!({
                "threadId":thread,"input":[{"type":"text","text":text,"text_elements":[]}]
            }),
        );
    }

    fn stop(&self) {
        if let (Some(thread), Some(turn)) =
            (self.thread.borrow().as_ref(), self.turn.borrow().as_ref())
        {
            self.request(
                Request::Interrupt,
                "turn/interrupt",
                json!({"threadId":thread,"turnId":turn}),
            );
            self.show_status("正在停止…");
        }
    }

    fn clear_history(&self) {
        self.history_generation
            .set(self.history_generation.get() + 1);
        self.live.take();
        self.diff.take();
        self.approvals.borrow_mut().clear();
        self.questions.borrow_mut().clear();
        self.history_cursor.take();
        self.older.hide();
        for child in self.history.children() {
            if child != self.older.clone().upcast::<gtk::Widget>() {
                self.history.remove(&child);
            }
        }
    }

    pub fn disconnect(&self, message: &str) {
        self.rpc.take();
        self.pending.borrow_mut().clear();
        self.opening.set(false);
        self.initialized.set(false);
        self.older.hide();
        self.history_cursor.take();
        self.thread.take();
        self.turn.take();
        self.active.set(false);
        self.remove_live();
        for (_, approval) in self.approvals.borrow_mut().drain() {
            self.history.remove(&approval);
        }
        for (_, question) in self.questions.borrow_mut().drain() {
            self.history.remove(&question);
        }
        self.settings.show();
        self.copy_id.hide();
        self.show_status(message);
        self.update_controls();
    }

    fn notification(&self, method: &str, params: &Value) {
        if let Some(id) = params["threadId"].as_str() {
            if self.thread.borrow().as_deref() != Some(id) {
                return;
            }
        }
        match method {
            "item/agentMessage/delta" => {
                if let (Some(id), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    self.delta(id, delta);
                }
            }
            "item/completed" => self.completed_item(&params["item"], false),
            "turn/started" => {
                self.active.set(true);
                self.turn
                    .replace(params["turn"]["id"].as_str().map(str::to_owned));
                self.update_controls();
            }
            "turn/diff/updated" => {
                if let (Some(turn), Some(diff)) =
                    (params["turnId"].as_str(), params["diff"].as_str())
                {
                    self.diff
                        .replace(Some((turn.to_owned(), limited(diff, 256 * 1024))));
                }
            }
            "turn/completed" => {
                self.remove_live();
                self.active.set(false);
                self.turn.take();
                for (_, approval) in self.approvals.borrow_mut().drain() {
                    self.history.remove(&approval);
                }
                let turn = &params["turn"];
                let diff = self
                    .diff
                    .take()
                    .filter(|(id, _)| turn["id"].as_str() == Some(id.as_str()));
                if let Some((_, diff)) = diff.filter(|(_, diff)| !diff.is_empty()) {
                    self.add_diff(&diff);
                } else {
                    let mut changes = String::new();
                    for item in array(&turn["items"]) {
                        append_file_changes(item, &mut changes);
                    }
                    if !changes.is_empty() {
                        self.add_diff(&changes);
                    }
                }
                let message =
                    turn["error"]["message"]
                        .as_str()
                        .unwrap_or(match turn["status"].as_str() {
                            Some("failed") => "会话失败",
                            Some("interrupted") => "已停止",
                            _ => "已完成",
                        });
                self.show_status(message);
                self.update_controls();
            }
            "serverRequest/resolved" => {
                if let Some(approval) = self.approvals.borrow_mut().remove(&params["requestId"]) {
                    self.history.remove(&approval);
                }
                if let Some(question) = self.questions.borrow_mut().remove(&params["requestId"]) {
                    self.history.remove(&question);
                }
            }
            "error" => {
                if let Some(message) = params["error"]["message"].as_str() {
                    self.show_status(message);
                }
            }
            _ => {}
        }
    }

    fn delta(&self, id: &str, delta: &str) {
        let same = self
            .live
            .borrow()
            .as_ref()
            .is_some_and(|live| live.id == id);
        if !same {
            self.remove_live();
            let label = agent_render::text("");
            self.append(&label);
            self.live.replace(Some(LiveMessage {
                id: id.into(),
                text: String::new(),
                label,
            }));
        }
        if let Some(live) = self.live.borrow_mut().as_mut() {
            if live.text.len() < 256 * 1024 {
                live.text.push_str(delta);
                live.label.set_text(&limited(&live.text, 256 * 1024));
                self.scroll_to_end();
            }
        }
    }

    fn remove_live(&self) {
        if let Some(live) = self.live.take() {
            self.history.remove(&live.label);
        }
    }

    fn completed_item(&self, item: &Value, loading_history: bool) {
        match item["type"].as_str() {
            Some("userMessage") if loading_history => {
                let items: Vec<_> = array(&item["content"])
                    .filter_map(|value| value["text"].as_str())
                    .collect();
                if !items.is_empty() {
                    self.add_user(&items.join("\n"));
                }
            }
            Some("agentMessage" | "plan") => {
                self.remove_live();
                if let Some(text) = item["text"].as_str() {
                    self.add_agent(text);
                }
            }
            Some("commandExecution") => {
                let command = item["command"].as_str().unwrap_or("");
                let output = item["aggregatedOutput"].as_str().unwrap_or("");
                let expander =
                    gtk::Expander::new(Some(&format!("命令 · {}", limited(command, 240))));
                expander.add(&agent_render::text(&limited(output, 24 * 1024)));
                expander.style_context().add_class("agent-command");
                self.append(&expander);
            }
            Some("fileChange") => {
                let paths: Vec<_> = array(&item["changes"])
                    .filter_map(|value| value["path"].as_str())
                    .collect();
                if !paths.is_empty() {
                    let card = gtk::Expander::new(Some(&format!("文件变更 · {} 项", paths.len())));
                    card.add(&agent_render::text(&paths.join("\n")));
                    card.style_context().add_class("agent-command");
                    self.append(&card);
                }
            }
            Some("imageGeneration") => {
                if let Some(path) = item["savedPath"].as_str() {
                    let image =
                        agent_render::image(path, "生成的图片", &self.context.borrow(), true);
                    self.append(&image);
                }
            }
            _ => {}
        }
    }

    fn server_request(self: &Rc<Self>, method: &str, id: Value, params: &Value) {
        if method == "item/tool/requestUserInput" {
            let weak = Rc::downgrade(self);
            let request = id.clone();
            let card = crate::agent_question::card(params, move |answers| {
                if let Some(agent) = weak.upgrade() {
                    if let Some(card) = agent.questions.borrow_mut().remove(&request) {
                        agent.history.remove(&card);
                        if let Some(rpc) = agent.rpc.borrow().as_ref() {
                            rpc.reply(request.clone(), answers);
                        }
                    }
                }
            });
            if let Some(card) = card {
                if let Some(previous) = self.questions.borrow_mut().insert(id, card.clone()) {
                    self.history.remove(&previous);
                }
                self.append(&card);
                return;
            }
        }
        let (title, detail) = match method {
            "item/commandExecution/requestApproval" => (
                "命令执行审批",
                params["command"]
                    .as_str()
                    .or_else(|| params["reason"].as_str())
                    .unwrap_or("Codex 请求扩大命令权限"),
            ),
            "item/fileChange/requestApproval" => (
                "文件变更审批",
                params["reason"]
                    .as_str()
                    .or_else(|| params["grantRoot"].as_str())
                    .unwrap_or("Codex 请求额外文件写入权限"),
            ),
            _ => {
                if let Some(rpc) = self.rpc.borrow().as_ref() {
                    rpc.unsupported(id);
                }
                return;
            }
        };
        let card = column(8);
        card.style_context().add_class("agent-approval");
        card.add(&agent_render::text(title));
        card.add(&agent_render::text(detail));
        let actions = row(6);
        for (label, value, primary) in [("允许一次", "accept", true), ("拒绝", "decline", false)]
        {
            let button = button(label, primary);
            actions.add(&button);
            let weak = Rc::downgrade(self);
            let id = id.clone();
            button.connect_clicked(move |_| {
                if let Some(agent) = weak.upgrade() {
                    if let Some(card) = agent.approvals.borrow_mut().remove(&id) {
                        agent.history.remove(&card);
                        if let Some(rpc) = agent.rpc.borrow().as_ref() {
                            rpc.reply(id.clone(), json!({"decision":value}));
                        }
                    }
                }
            });
        }
        card.add(&actions);
        self.approvals.borrow_mut().insert(id, card.clone());
        self.append(&card);
    }

    fn add_diff(&self, diff: &str) {
        let expander = gtk::Expander::new(Some("本轮变更 · 查看 diff"));
        expander.style_context().add_class("agent-command");
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Automatic)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .height_request(250)
            .build();
        let view = gtk::TextView::builder()
            .editable(false)
            .monospace(true)
            .build();
        view.set_left_margin(7);
        view.style_context().add_class("agent-diff");
        if let Some(buffer) = view.buffer() {
            let added = gtk::TextTag::builder().foreground("#83cb9b").build();
            let removed = gtk::TextTag::builder().foreground("#f0838c").build();
            let context = gtk::TextTag::builder().foreground("#82aaff").build();
            let table = buffer.tag_table().expect("diff tag table");
            for tag in [&added, &removed, &context] {
                table.add(tag);
            }
            let diff = limited(diff, 256 * 1024);
            for line in diff.split_inclusive('\n') {
                let tag = if ["+++", "---", "@@", "diff --git"]
                    .into_iter()
                    .any(|prefix| line.starts_with(prefix))
                {
                    Some(&context)
                } else if line.starts_with('+') {
                    Some(&added)
                } else if line.starts_with('-') {
                    Some(&removed)
                } else {
                    None
                };
                if let Some(tag) = tag {
                    buffer.insert_with_tags(&mut buffer.end_iter(), line, &[tag]);
                } else {
                    buffer.insert(&mut buffer.end_iter(), line);
                }
            }
        }
        scroll.add(&view);
        expander.add(&scroll);
        self.append(&expander);
    }

    fn add_user(&self, text: &str) {
        let label = agent_render::text(&limited(text, 256 * 1024));
        label.style_context().add_class("agent-user");
        self.append(&label);
    }

    fn add_agent(&self, text: &str) {
        let text = limited(text, 256 * 1024);
        let message = column(6);
        let actions = row(6);
        let markdown = button("复制 Markdown", false);
        let rich = button("复制富文本", false);
        let payload = text.clone();
        markdown.connect_clicked(move |_| agent_render::clipboard().set_text(&payload));
        let payload = text.clone();
        rich.connect_clicked(move |_| agent_render::copy_rich(payload.clone()));
        actions.pack_end(&rich, false, false, 0);
        actions.pack_end(&markdown, false, false, 0);
        message.add(&agent_render::response(&text, &self.context.borrow()));
        message.add(&actions);
        self.append(&message);
    }

    fn append(&self, widget: &impl IsA<gtk::Widget>) {
        self.history.add(widget);
        widget.show_all();
        if let Some(index) = self.prepend_at.get() {
            self.history.reorder_child(widget, index);
            self.prepend_at.set(Some(index + 1));
        } else {
            self.scroll_to_end();
        }
    }

    fn scroll_to_end(&self) {
        let scroll = self.scroll.downgrade();
        glib::idle_add_local_once(move || {
            if let Some(scroll) = scroll.upgrade() {
                let adjustment = scroll.vadjustment();
                adjustment.set_value(
                    (adjustment.upper() - adjustment.page_size()).max(adjustment.lower()),
                );
            }
        });
    }

    pub fn show_status(&self, text: &str) {
        self.status.set_text(&text.replace('\0', "�"));
        self.status.set_tooltip_text(Some(&text.replace('\0', "�")));
    }

    fn update_controls(&self) {
        let running = self.active.get();
        let ready = self.thread.borrow().is_some();
        let opening =
            self.opening.get() || (self.rpc.borrow().is_some() && !self.initialized.get());
        self.connect.set_sensitive(!opening && !running);
        self.input.set_sensitive(ready);
        self.send.set_sensitive(ready && !running && !opening);
        self.stop
            .set_sensitive(running && self.turn.borrow().is_some());
    }
}

fn append_file_changes(item: &Value, out: &mut String) {
    if item["type"] != "fileChange" {
        return;
    }
    for change in array(&item["changes"]) {
        if out.len() >= 256 * 1024 {
            break;
        }
        if let Some(diff) = change["diff"].as_str().filter(|diff| !diff.is_empty()) {
            if let Some(path) = change["path"].as_str() {
                out.push_str(&format!("diff --git {path}\n"));
            }
            out.push_str(&limited(
                diff,
                (256 * 1024 - out.len().min(256 * 1024)).max(1),
            ));
            out.push('\n');
        }
    }
}

fn array(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn limited(text: &str, max: usize) -> String {
    let cleaned = text.replace('\0', "�");
    if cleaned.len() <= max {
        return cleaned;
    }
    let mut end = max;
    while !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &cleaned[..end])
}

fn row(spacing: i32) -> gtk::Box {
    gtk::Box::new(gtk::Orientation::Horizontal, spacing)
}
fn column(spacing: i32) -> gtk::Box {
    gtk::Box::new(gtk::Orientation::Vertical, spacing)
}

fn button(label: &str, primary: bool) -> gtk::Button {
    let button = gtk::Button::with_label(label);
    button
        .style_context()
        .add_class(if primary { "primary" } else { "quiet-button" });
    button
}
