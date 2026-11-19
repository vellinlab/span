use crate::agent_activity::{self, Activity, Record};
use crate::agent_attachments::{Attachments, Prepared};
use crate::agent_catalog::{self, Catalog};
use crate::agent_diff::DiffCard;
use crate::agent_options::{Options, Selection};
use crate::agent_render::{self, Context};
use crate::agent_rpc::Rpc;
use crate::agent_usage::Usage;
use crate::icons::{self, Icon};
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
    Models(u64),
    Quota,
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

struct TurnDiff {
    id: String,
    expander: gtk::Expander,
    card: DiffCard,
}

#[derive(Clone, Copy, PartialEq)]
enum ComposerAction {
    Send,
    Stop,
    Continue,
}

impl ComposerAction {
    fn presentation(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Send => ("send", "发送", "发送（Ctrl+Enter）"),
            Self::Stop => ("stop", "中断推理", "中断当前推理"),
            Self::Continue => ("continue", "继续推理", "继续上次任务（Ctrl+Enter）"),
        }
    }
}

pub struct Agent {
    pub panel: gtk::Box,
    connection: Box<dyn Fn() -> Result<Option<PathBuf>, String>>,
    reveal: Box<dyn Fn()>,
    rpc: RefCell<Option<Rc<Rpc>>>,
    pending: RefCell<HashMap<u64, Request>>,
    thread: RefCell<Option<String>>,
    last_thread: RefCell<Option<String>>,
    turn: RefCell<Option<String>>,
    active: Cell<bool>,
    interrupting: Cell<bool>,
    can_continue: Cell<bool>,
    context: RefCell<Context>,
    approvals: RefCell<HashMap<Value, gtk::Box>>,
    live: RefCell<Option<LiveMessage>>,
    activity: RefCell<Option<(String, Activity)>>,
    history: gtk::Box,
    older: gtk::Button,
    history_cursor: RefCell<Option<String>>,
    history_generation: Cell<u64>,
    prepend_at: Cell<Option<i32>>,
    opening: Cell<bool>,
    initialized: Cell<bool>,
    list_serial: Cell<u64>,
    catalog: Catalog,
    questions: RefCell<HashMap<Value, gtk::Box>>,
    diff: RefCell<Option<TurnDiff>>,
    scroll: gtk::ScrolledWindow,
    scroll_scheduled: Rc<Cell<bool>>,
    status: gtk::Label,
    settings: gtk::Box,
    cwd: gtk::Entry,
    resume: gtk::Entry,
    connect: gtk::Button,
    copy_id: gtk::Button,
    input: gtk::TextView,
    options: Options,
    model_provider: RefCell<Option<String>>,
    usage: Usage,
    quota_started: Cell<bool>,
    attachments: Rc<Attachments>,
    uploading: Cell<bool>,
    pending_user: RefCell<Option<gtk::Label>>,
    client_message: RefCell<Option<String>>,
    primary_action: Cell<Option<ComposerAction>>,
    primary: gtk::Button,
    primary_icons: gtk::Stack,
}

impl Agent {
    pub fn new(
        host: &str,
        initial_directory: Option<&std::path::Path>,
        connection: impl Fn() -> Result<Option<PathBuf>, String> + 'static,
        toggle_terminal: impl Fn() + 'static,
        reveal: impl Fn() + 'static,
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
        catalog_button.set_action_name(Some("win.agent-catalog"));
        toolbar.pack_end(&catalog_button, false, false, 0);
        let catalog = Catalog::new(host);
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

        let history = crate::reading_column::new(18);
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

        let composer = crate::reading_column::new(0);
        composer.style_context().add_class("agent-composer");
        let card = column(5);
        card.style_context().add_class("agent-compose-card");
        let input = gtk::TextView::builder()
            .wrap_mode(gtk::WrapMode::WordChar)
            .pixels_above_lines(2)
            .pixels_below_lines(2)
            .accepts_tab(false)
            .build();
        let input_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .height_request(62)
            .build();
        input_scroll.add(&input);
        let editor = gtk::Overlay::new();
        editor.add(&input_scroll);
        let placeholder = gtk::Label::new(Some("输入消息，或添加附件"));
        placeholder
            .style_context()
            .add_class("agent-compose-placeholder");
        placeholder.set_halign(gtk::Align::Start);
        placeholder.set_valign(gtk::Align::Start);
        placeholder.set_no_show_all(true);
        editor.add_overlay(&placeholder);
        editor.set_overlay_pass_through(&placeholder, true);
        placeholder.show();
        if let Some(buffer) = input.buffer() {
            let placeholder = placeholder.downgrade();
            buffer.connect_changed(move |buffer| {
                if let Some(placeholder) = placeholder.upgrade() {
                    placeholder.set_visible(buffer.char_count() == 0);
                }
            });
        }
        let inputs = row(4);
        let attachments = Attachments::new();
        inputs.pack_start(&attachments.button, false, false, 0);
        let options = Options::new(&inputs);
        let usage = Usage::new();
        let primary = gtk::Button::new();
        primary.style_context().add_class("primary");
        primary.style_context().add_class("agent-send");
        primary.set_valign(gtk::Align::Center);
        primary.set_margin_start(4);
        let primary_icons = gtk::Stack::new();
        primary_icons
            .style_context()
            .add_class("agent-primary-icons");
        for (action, icon) in [
            (ComposerAction::Send, Icon::Up),
            (ComposerAction::Stop, Icon::Stop),
            (ComposerAction::Continue, Icon::Pause),
        ] {
            primary_icons.add_named(&icons::widget(icon, 17), action.presentation().0);
        }
        primary.add(&primary_icons);
        primary.set_focus_on_click(false);
        inputs.pack_end(&primary, false, false, 0);
        inputs.pack_end(&usage.button, false, false, 0);
        card.pack_start(&editor, false, false, 0);
        card.pack_start(&attachments.chips, false, false, 0);
        card.pack_end(&inputs, false, false, 0);
        composer.add(&card);
        panel.pack_end(&composer, false, false, 0);

        let agent = Rc::new(Self {
            panel,
            connection: Box::new(connection),
            reveal: Box::new(reveal),
            rpc: RefCell::new(None),
            pending: RefCell::new(HashMap::new()),
            thread: RefCell::new(None),
            last_thread: RefCell::new(None),
            turn: RefCell::new(None),
            active: Cell::new(false),
            interrupting: Cell::new(false),
            can_continue: Cell::new(false),
            context: RefCell::new(Context {
                cwd: PathBuf::new(),
                socket: None,
            }),
            approvals: RefCell::new(HashMap::new()),
            live: RefCell::new(None),
            activity: RefCell::new(None),
            history,
            older,
            history_cursor: RefCell::new(None),
            history_generation: Cell::new(0),
            prepend_at: Cell::new(None),
            opening: Cell::new(false),
            initialized: Cell::new(false),
            list_serial: Cell::new(0),
            catalog,
            questions: RefCell::new(HashMap::new()),
            diff: RefCell::new(None),
            scroll,
            scroll_scheduled: Rc::new(Cell::new(false)),
            status,
            settings,
            cwd,
            resume,
            connect,
            copy_id,
            input,
            options,
            model_provider: RefCell::new(None),
            usage,
            quota_started: Cell::new(false),
            attachments,
            uploading: Cell::new(false),
            pending_user: RefCell::new(None),
            client_message: RefCell::new(None),
            primary_action: Cell::new(None),
            primary,
            primary_icons,
        });
        agent.bind();
        agent.update_controls();
        agent
    }

    fn bind(self: &Rc<Self>) {
        self.bind_catalog();
        self.bind_composer();
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
        self.primary.connect_map(move |button| {
            if let Some(action) = weak.upgrade().and_then(|agent| agent.primary_action.get()) {
                if let Some(accessible) = button.accessible() {
                    accessible.set_name(action.presentation().1);
                }
            }
        });
        let weak = Rc::downgrade(self);
        self.primary.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                if agent.active.get() {
                    agent.stop();
                } else {
                    agent.submit_prompt();
                }
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
                && [Return, KP_Enter].contains(&event.keyval())
            {
                if let Some(agent) = weak.upgrade() {
                    agent.submit_prompt();
                }
                glib::Propagation::Stop
            } else {
                glib::Propagation::Proceed
            }
        });
    }

    fn bind_composer(self: &Rc<Self>) {
        if let Some(buffer) = self.input.buffer() {
            let weak = Rc::downgrade(self);
            buffer.connect_changed(move |_| {
                if let Some(agent) = weak.upgrade().filter(|agent| agent.can_continue.get()) {
                    agent.update_primary();
                }
            });
        }
        let weak = Rc::downgrade(self);
        self.attachments
            .chips
            .connect_notify_local(Some("visible"), move |_, _| {
                if let Some(agent) = weak.upgrade().filter(|agent| agent.can_continue.get()) {
                    agent.update_primary();
                }
            });
        let weak = Rc::downgrade(self);
        self.options.model.connect_changed(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.options.model_changed();
            }
        });
        let weak = Rc::downgrade(self);
        self.usage.button.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.usage.popover.popup();
                if !agent.quota_started.get() {
                    agent.read_quota();
                }
            }
        });
        let weak = Rc::downgrade(self);
        self.usage.refresh.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                agent.read_quota();
            }
        });
        let weak = Rc::downgrade(self);
        self.attachments.button.connect_clicked(move |_| {
            if let Some(agent) = weak.upgrade() {
                let weak = Rc::downgrade(&agent);
                agent.attachments.choose(move |paths| {
                    if let Some(agent) = weak
                        .upgrade()
                        .filter(|agent| agent.attachments.button.is_sensitive())
                    {
                        if let Err(error) = agent.attachments.add(paths) {
                            agent.show_status(error);
                        }
                    }
                });
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
                agent.show_catalog(false);
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
                        || agent.uploading.get()
                        || agent.opening.get()
                        || !agent.questions.borrow().is_empty()
                    {
                        agent.catalog.show_status("请先结束当前任务或回答提问");
                        return;
                    }
                    (agent.reveal)();
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
                if agent.active.get()
                    || agent.uploading.get()
                    || agent.opening.get()
                    || !agent.questions.borrow().is_empty()
                {
                    agent.catalog.show_status("请先结束当前任务或回答提问");
                    return;
                }
                (agent.reveal)();
                agent.resume.set_text("");
                agent.settings.show();
                agent.cwd.grab_focus();
            }
        });
    }

    pub fn catalog_panel(&self) -> &gtk::Box {
        &self.catalog.panel
    }

    pub fn focus_catalog(&self) {
        self.catalog.search.grab_focus();
    }

    pub fn show_catalog(self: &Rc<Self>, focus: bool) {
        if focus {
            self.focus_catalog();
        }
        if self.initialized.get() {
            self.load_catalog(None);
        } else {
            self.catalog.loading(true);
            self.start_rpc(true);
        }
    }

    fn load_catalog(&self, cursor: Option<String>) {
        if !self.initialized.get() || !self.catalog.panel.is_mapped() {
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
        if self.active.get()
            || self.uploading.get()
            || self.opening.get()
            || !self.questions.borrow().is_empty()
        {
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
            "clientInfo":{"name":env!("CARGO_PKG_NAME"),"title":crate::APP_NAME,"version":env!("CARGO_PKG_VERSION")},
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

    fn load_models(&self, cursor: Option<String>) {
        let mut params = json!({"limit":50,"cursor":cursor});
        if let Some(provider) = self.model_provider.borrow().as_deref() {
            params["modelProvider"] = json!(provider);
        }
        self.request(
            Request::Models(self.history_generation.get()),
            "model/list",
            params,
        );
    }

    fn read_quota(&self) {
        if self.initialized.get() && self.usage.refresh.is_sensitive() {
            self.quota_started.set(true);
            self.usage.loading();
            self.request(Request::Quota, "account/rateLimits/read", Value::Null);
        }
    }

    fn load_turns(&self, data: &Value, newest_first: bool, prepend: bool) {
        let Some(turns) = data.as_array() else { return };
        if prepend {
            self.prepend_at.set(Some(1));
        }
        let mut running = None;
        let mut latest_status = None;
        let turns: Box<dyn Iterator<Item = &Value>> = if newest_first {
            Box::new(turns.iter().rev())
        } else {
            Box::new(turns.iter())
        };
        for turn in turns {
            let mut changes = String::new();
            let mut activity = None;
            for item in array(&turn["items"]) {
                if let Some(record) = Record::from_item(item) {
                    activity
                        .get_or_insert_with(|| self.new_activity())
                        .record(record);
                } else {
                    self.completed_item(item, true);
                }
                append_file_changes(item, &mut changes);
            }
            if !changes.is_empty() {
                self.add_diff(&changes);
            }
            let status = turn["status"].as_str();
            latest_status = status;
            if !prepend && status == Some("inProgress") {
                running = turn["id"].as_str().map(str::to_owned);
                if let (Some(id), Some(activity)) = (&running, activity.take()) {
                    self.activity.replace(Some((id.clone(), activity)));
                }
            }
            if let Some(activity) = activity {
                activity.finish(status);
            }
        }
        self.prepend_at.set(None);
        if !prepend {
            self.can_continue.set(latest_status == Some("interrupted"));
        }
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
        if self.uploading.get() || self.pending_user.borrow().is_some() {
            self.show_status("请等当前消息发送完成");
            return;
        }
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
                    Request::Models(generation) if generation == self.history_generation.get() => {
                        self.options
                            .model
                            .set_tooltip_text(Some(&error.replace('\0', "�")));
                        self.options.render_models();
                        self.update_controls();
                    }
                    Request::Quota => self.usage.unavailable(error),
                    Request::Turns {
                        prepend,
                        generation,
                    } if generation == self.history_generation.get() => {
                        self.older.set_sensitive(prepend);
                        self.show_status(error);
                    }
                    Request::Send => {
                        self.active.set(false);
                        self.turn.take();
                        self.client_message.take();
                        self.finish_activity(Some("failed"));
                        self.remove_pending_user();
                        self.show_status(error);
                        self.update_controls();
                    }
                    Request::Interrupt => {
                        if self.interrupting.replace(false) {
                            self.show_status(error);
                            self.update_controls();
                        }
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
                self.options.open(result);
                self.options
                    .model
                    .set_tooltip_text(Some("选择下一条消息使用的模型"));
                self.usage.clear_tokens();
                self.model_provider
                    .replace(result["modelProvider"].as_str().map(str::to_owned));
                self.load_models(None);
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
                self.show_status(if self.can_continue.get() {
                    "已中断"
                } else {
                    "就绪"
                });
                self.update_controls();
                self.input.grab_focus();
            }
            Request::Catalog(serial) => {
                if serial == self.list_serial.get() {
                    self.catalog.update(result);
                }
            }
            Request::Models(generation) => {
                if generation == self.history_generation.get() {
                    if let Some(cursor) = self.options.add_page(result) {
                        self.load_models(Some(cursor));
                    } else {
                        self.update_controls();
                    }
                }
            }
            Request::Quota => self.usage.quota(result, true),
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
                if self.pending_user.take().is_some() {
                    self.options.remember();
                    if let Some(buffer) = self.input.buffer() {
                        buffer.set_text("");
                    }
                    self.attachments.clear();
                }
                if self.active.get() {
                    self.turn
                        .replace(result["turn"]["id"].as_str().map(str::to_owned));
                }
                self.update_controls();
            }
            Request::Interrupt => {}
        }
    }

    fn send(self: &Rc<Self>) {
        if self.active.get()
            || self.opening.get()
            || self.uploading.get()
            || self.pending_user.borrow().is_some()
        {
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
        let text = text.trim().to_owned();
        let paths = self.attachments.paths();
        if text.is_empty() && paths.is_empty() {
            return;
        }
        if text.len() > 256 * 1024 {
            self.show_status("输入超过 256 KiB。");
            return;
        }
        let selection = self.options.selection();
        if paths.is_empty() {
            self.begin_turn(thread, &text, &selection, Prepared::empty());
            return;
        }
        let socket = self.context.borrow().socket.clone();
        let generation = self.history_generation.get();
        let weak = Rc::downgrade(self);
        self.uploading.set(true);
        self.show_status(if socket.is_some() {
            "正在上传附件…"
        } else {
            "正在读取附件…"
        });
        self.update_controls();
        glib::MainContext::default().spawn_local(async move {
            let result = gio::spawn_blocking(move || Prepared::read(paths, socket.as_deref()))
                .await
                .unwrap_or_else(|_| Err("附件准备中断。".into()));
            if let Some(agent) = weak.upgrade() {
                if agent.history_generation.get() != generation || !agent.uploading.replace(false) {
                    return;
                }
                match result {
                    Ok(attachments) => agent.begin_turn(thread, &text, &selection, attachments),
                    Err(error) => {
                        agent.show_status(&error);
                        agent.update_controls();
                    }
                }
            }
        });
    }

    fn begin_turn(&self, thread: String, text: &str, selection: &Selection, files: Prepared) {
        let message_id = glib::uuid_string_random().to_string();
        let mut params = json!({
            "threadId": thread,
            "input": files.input(text, selection.images),
            "summary": "auto",
            "clientUserMessageId": message_id,
        });
        selection.apply(&mut params);
        let label = self.add_user(&files.summary(text));
        self.pending_user.replace(Some(label));
        self.client_message.replace(Some(message_id));
        self.active.set(true);
        self.show_status("Codex 正在处理…");
        self.update_controls();
        self.request(Request::Send, "turn/start", params);
    }

    fn remove_pending_user(&self) {
        if let Some(label) = self.pending_user.take() {
            self.history.remove(&label);
        }
    }

    fn stop(&self) {
        if !self.active.get() || self.interrupting.get() {
            return;
        }
        if let (Some(thread), Some(turn)) =
            (self.thread.borrow().clone(), self.turn.borrow().clone())
        {
            self.interrupting.set(true);
            self.request(
                Request::Interrupt,
                "turn/interrupt",
                json!({"threadId":thread,"turnId":turn}),
            );
            self.show_status("正在中断…");
            self.update_controls();
        }
    }

    fn submit_prompt(self: &Rc<Self>) {
        if self.active.get() || !self.primary.is_sensitive() {
            return;
        }
        if self.primary_action.get() == Some(ComposerAction::Continue) {
            let thread = self.thread.borrow().clone();
            if let Some(thread) = thread {
                self.begin_turn(
                    thread,
                    "请继续上一轮未完成的任务。",
                    &self.options.selection(),
                    Prepared::empty(),
                );
            }
        } else {
            self.send();
        }
    }

    fn clear_history(&self) {
        self.history_generation
            .set(self.history_generation.get() + 1);
        self.live.take();
        self.activity.take();
        self.diff.take();
        self.approvals.borrow_mut().clear();
        self.questions.borrow_mut().clear();
        self.history_cursor.take();
        self.client_message.take();
        self.can_continue.set(false);
        self.interrupting.set(false);
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
        self.uploading.set(false);
        self.remove_pending_user();
        self.client_message.take();
        self.options.open(&Value::Null);
        self.usage.disconnect();
        self.quota_started.set(false);
        self.older.hide();
        self.history_cursor.take();
        self.thread.take();
        self.turn.take();
        self.active.set(false);
        self.can_continue.set(false);
        self.interrupting.set(false);
        self.finish_activity(Some("disconnected"));
        self.diff.take();
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
            "thread/tokenUsage/updated" => self.usage.tokens(&params["tokenUsage"]),
            "account/rateLimits/updated" => self.usage.quota(params, false),
            "item/agentMessage/delta" => {
                if let (Some(id), Some(delta)) =
                    (params["itemId"].as_str(), params["delta"].as_str())
                {
                    self.delta(id, delta);
                }
            }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                if let Some(record) = Record::from_item(item) {
                    if let Some(turn) = params["turnId"].as_str() {
                        self.update_activity(turn, |activity| activity.record(record));
                    }
                } else if method == "item/completed" {
                    self.completed_item(item, false);
                }
            }
            "item/reasoning/summaryTextDelta" => {
                if let (Some(turn), Some((id, index, delta))) = (
                    params["turnId"].as_str(),
                    agent_activity::summary_delta(params),
                ) {
                    self.update_activity(turn, |activity| activity.summary(id, index, delta));
                }
            }
            "item/fileChange/patchUpdated" => {
                if let (Some(turn), Some(id)) =
                    (params["turnId"].as_str(), params["itemId"].as_str())
                {
                    let record = Record::patch(id, &params["changes"], Some("inProgress"));
                    self.update_activity(turn, |activity| activity.record(record));
                }
            }
            "turn/started" => {
                self.active.set(true);
                self.turn
                    .replace(params["turn"]["id"].as_str().map(str::to_owned));
                self.show_status("Codex 正在处理…");
                self.update_controls();
            }
            "turn/diff/updated" => {
                if let (Some(turn), Some(diff)) =
                    (params["turnId"].as_str(), params["diff"].as_str())
                {
                    if self.is_active_turn(turn) {
                        let mut live = self.diff.borrow_mut();
                        if live.as_ref().is_none_or(|entry| entry.id != turn) {
                            let (expander, card) = self.add_diff(diff);
                            live.replace(TurnDiff {
                                id: turn.into(),
                                expander,
                                card,
                            });
                        } else if let Some(live) = live.as_ref() {
                            live.card.update(diff);
                            live.expander.set_visible(!diff.is_empty());
                        }
                    }
                }
            }
            "turn/completed" => {
                let turn = &params["turn"];
                let status = turn["status"].as_str();
                let interrupted = status == Some("interrupted");
                if let Some(id) = turn["id"].as_str() {
                    for record in array(&turn["items"]).filter_map(Record::from_item) {
                        self.update_activity(id, |activity| activity.record(record));
                    }
                }
                self.finish_activity(status);
                if interrupted {
                    self.live.take();
                } else {
                    self.remove_live();
                }
                self.active.set(false);
                self.turn.take();
                self.interrupting.set(false);
                self.client_message.take();
                self.can_continue.set(interrupted);
                for (_, approval) in self.approvals.borrow_mut().drain() {
                    self.history.remove(&approval);
                }
                for (_, question) in self.questions.borrow_mut().drain() {
                    self.history.remove(&question);
                }
                let diff = self.diff.take();
                if !diff.is_some_and(|entry| turn["id"].as_str() == Some(entry.id.as_str())) {
                    let mut changes = String::new();
                    for item in array(&turn["items"]) {
                        append_file_changes(item, &mut changes);
                    }
                    if !changes.is_empty() {
                        self.add_diff(&changes);
                    }
                }
                let message = turn["error"]["message"].as_str().unwrap_or(match status {
                    Some("failed") => "会话失败",
                    Some("interrupted") => "已中断",
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

    fn new_activity(&self) -> Activity {
        let activity = Activity::new();
        self.append(&activity.widget);
        activity
    }

    fn update_activity(&self, turn: &str, update: impl FnOnce(&mut Activity)) {
        if !self.is_active_turn(turn) {
            return;
        }
        let mut activity = self.activity.borrow_mut();
        if activity.as_ref().is_some_and(|(id, _)| id != turn) {
            if let Some((_, older)) = activity.take() {
                older.finish(None);
            }
        }
        let (_, activity) = activity.get_or_insert_with(|| (turn.to_owned(), self.new_activity()));
        update(activity);
    }

    fn is_active_turn(&self, turn: &str) -> bool {
        self.active.get() && self.turn.borrow().as_deref().is_none_or(|id| id == turn)
    }

    fn finish_activity(&self, status: Option<&str>) {
        if let Some((_, activity)) = self.activity.take() {
            activity.finish(status);
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
            label.style_context().add_class("agent-prose");
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
            Some("userMessage")
                if loading_history
                    || self.client_message.borrow().as_deref().is_none_or(|local| {
                        item["clientId"].as_str().is_some_and(|id| id != local)
                    }) =>
            {
                let items: Vec<_> = array(&item["content"])
                    .filter_map(|value| match value["type"].as_str() {
                        Some("text") => value["text"].as_str().map(str::to_owned),
                        Some("localImage") => value["path"].as_str().map(|path| {
                            format!(
                                "附件 · {}",
                                crate::agent_attachments::filename(std::path::Path::new(path))
                            )
                        }),
                        Some("image") => Some("附件 · 图片".into()),
                        _ => None,
                    })
                    .collect();
                if !items.is_empty() {
                    self.add_user(&items.join("\n"));
                }
            }
            Some("agentMessage" | "plan") => {
                self.remove_live();
                if let Some(text) = item["text"].as_str() {
                    self.add_agent(text, loading_history);
                }
            }
            Some("imageGeneration") => {
                if let Some(path) = item["savedPath"].as_str() {
                    let image = agent_render::image(
                        path,
                        "生成的图片",
                        &self.context.borrow(),
                        !loading_history,
                    );
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

    fn add_diff(&self, diff: &str) -> (gtk::Expander, DiffCard) {
        let expander = gtk::Expander::new(Some("本轮变更 · 查看 diff"));
        expander.style_context().add_class("agent-command");
        let card = DiffCard::new("本轮改动");
        card.update(diff);
        expander.add(card.widget());
        let history = self.history.downgrade();
        let timeline = self.scroll.downgrade();
        expander.connect_notify_local(Some("expanded"), move |expander, _| {
            if !expander.property::<bool>("expanded") {
                return;
            }
            let expander = expander.downgrade();
            let history = history.clone();
            let timeline = timeline.clone();
            glib::timeout_add_local_once(std::time::Duration::from_millis(32), move || {
                if let (Some(expander), Some(history), Some(timeline)) =
                    (expander.upgrade(), history.upgrade(), timeline.upgrade())
                {
                    if let Some((_, top)) = expander.translate_coordinates(&history, 0, 0) {
                        timeline.vadjustment().clamp_page(
                            f64::from(top),
                            f64::from(top + expander.allocated_height()),
                        );
                    }
                }
            });
        });
        self.append(&expander);
        expander.set_visible(!diff.is_empty());
        (expander, card)
    }

    fn add_user(&self, text: &str) -> gtk::Label {
        let label = agent_render::text(&limited(text, 256 * 1024));
        label.set_halign(gtk::Align::End);
        label.set_max_width_chars(52);
        label.style_context().add_class("agent-user");
        self.append(&label);
        label
    }

    fn add_agent(&self, text: &str, loading_history: bool) {
        let text = limited(text, 256 * 1024);
        let message = column(6);
        message.style_context().add_class("agent-response");
        let actions = row(6);
        let markdown = button("复制 Markdown", false);
        let rich = button("复制富文本", false);
        let payload = text.clone();
        markdown.connect_clicked(move |_| agent_render::clipboard().set_text(&payload));
        let payload = text.clone();
        rich.connect_clicked(move |_| agent_render::copy_rich(payload.clone()));
        actions.pack_end(&rich, false, false, 0);
        actions.pack_end(&markdown, false, false, 0);
        message.add(&agent_render::response(
            &text,
            &self.context.borrow(),
            !loading_history,
        ));
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
        if self.scroll_scheduled.replace(true) {
            return;
        }
        let scroll = self.scroll.downgrade();
        let scheduled = self.scroll_scheduled.clone();
        // Give GTK a frame to allocate the cards before reading the scroll range.
        glib::timeout_add_local_once(std::time::Duration::from_millis(32), move || {
            scheduled.set(false);
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
        let waiting = self.uploading.get() || self.pending_user.borrow().is_some();
        self.connect.set_sensitive(!opening && !running && !waiting);
        self.input.set_sensitive(ready);
        self.input.set_editable(!waiting);
        self.attachments
            .button
            .set_sensitive(ready && !opening && !waiting);
        self.attachments
            .chips
            .set_sensitive(ready && !opening && !waiting);
        self.options.update(ready && !opening && !waiting);
        self.usage.button.set_sensitive(ready);
        self.update_primary();
    }

    fn update_primary(&self) {
        let action = if self.active.get() {
            ComposerAction::Stop
        } else if self.can_continue.get()
            && !self.attachments.chips.is_visible()
            && self.input.buffer().is_none_or(|buffer| {
                buffer
                    .text(&buffer.start_iter(), &buffer.end_iter(), false)
                    .is_none_or(|text| text.trim().is_empty())
            })
        {
            ComposerAction::Continue
        } else {
            ComposerAction::Send
        };
        if self.primary_action.replace(Some(action)) != Some(action) {
            let (icon, name, tooltip) = action.presentation();
            self.primary_icons.set_visible_child_name(icon);
            self.primary.set_tooltip_text(Some(tooltip));
            if self.primary.is_mapped() {
                if let Some(accessible) = self.primary.accessible() {
                    accessible.set_name(name);
                }
            }
            let style = self.primary.style_context();
            if action == ComposerAction::Continue {
                style.add_class("agent-continue");
            } else {
                style.remove_class("agent-continue");
            }
        }
        let enabled = if action == ComposerAction::Stop {
            self.turn.borrow().is_some() && !self.interrupting.get()
        } else {
            self.thread.borrow().is_some()
                && !self.opening.get()
                && !self.uploading.get()
                && self.pending_user.borrow().is_none()
        };
        self.primary.set_sensitive(enabled);
    }
}

fn append_file_changes(item: &Value, out: &mut String) {
    if item["type"] == "fileChange" {
        append_changes(&item["changes"], out);
    }
}

pub(crate) fn append_changes(changes: &Value, out: &mut String) {
    for change in array(changes) {
        if out.len() >= 256 * 1024 {
            break;
        }
        if let Some(diff) = change["diff"].as_str().filter(|diff| !diff.is_empty()) {
            if let Some(path) = change["path"]
                .as_str()
                .filter(|_| !diff.starts_with("diff --git "))
            {
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

pub(crate) fn limited(text: &str, max: usize) -> String {
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
