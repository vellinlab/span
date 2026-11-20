use crate::agent::limited;
use crate::agent_render::{open_link, web_url};
use crate::icons::{self, Icon};
use gtk::prelude::*;
use gtk::{gdk, pango};
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

const PAGE_SIZE: usize = 18;

const CHATGPT_PLUGINS: &str = "https://chatgpt.com/plugins";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Plugins,
    Apps,
}

impl Section {
    fn id(self) -> &'static str {
        match self {
            Self::Plugins => "plugins",
            Self::Apps => "apps",
        }
    }
}

#[derive(Clone)]
pub struct Plugin {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) logo: Option<String>,
    pub(crate) source: String,
    pub(crate) path: Option<String>,
    pub(crate) marketplace: String,
    pub(crate) installed: bool,
    pub(crate) enabled: bool,
    pub(crate) available: bool,
    pub(crate) review: bool,
    pub(crate) featured: Option<usize>,
}

impl Plugin {
    pub fn parameters(&self) -> Value {
        match &self.path {
            Some(path) => json!({"pluginName":self.name,"marketplacePath":path}),
            None => json!({"pluginName":self.name,"remoteMarketplaceName":self.marketplace}),
        }
    }
}

struct App {
    id: String,
    name: String,
    description: String,
    logo: Option<String>,
    url: Option<String>,
    connected: bool,
    enabled: bool,
}

impl App {
    fn parse(item: &Value) -> Option<Self> {
        Some(Self {
            id: item["id"].as_str()?.to_owned(),
            name: item["name"].as_str()?.to_owned(),
            description: synopsis(
                item["appMetadata"]["seoDescription"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .or(item["description"].as_str()),
            ),
            logo: crate::extension_art::reference(item, &["logoUrlDark", "logoUrl"])
                .map(str::to_owned),
            url: install_url(item).map(str::to_owned),
            connected: item["isAccessible"] == true,
            enabled: item["isEnabled"] != false,
        })
    }
}

enum Entry {
    Plugin(Plugin),
    App(App),
}

pub enum Action {
    Load(Section, bool, Option<String>),
    Review(Plugin),
    Install(Plugin),
    Uninstall(String),
    Configure(String, bool),
}

pub enum Request {
    List { section: Section, append: bool },
    Review(Plugin),
    Change(Section),
}

struct Page {
    root: gtk::Box,
    entries: RefCell<Vec<Entry>>,
    rows: gtk::Box,
    state: gtk::Label,
    more: gtk::Button,
    cursor: RefCell<Option<String>>,
    loaded: Cell<bool>,
    loading: Cell<bool>,
    limit: Cell<usize>,
    has_local_more: Cell<bool>,
    expanded: Rc<RefCell<HashSet<String>>>,
    empty: gtk::Label,
}

impl Page {
    fn new() -> Self {
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        root.style_context().add_class("extensions-page");
        let rows = gtk::Box::new(gtk::Orientation::Vertical, 5);
        let state = label("", 3);
        state.style_context().add_class("preview-detail");
        state.set_no_show_all(true);
        let more = gtk::Button::with_label("加载更多");
        more.style_context().add_class("quiet-button");
        more.set_no_show_all(true);
        let content = gtk::Box::new(gtk::Orientation::Vertical, 6);
        content.add(&state);
        content.add(&rows);
        let empty = label("没有匹配的项目", 1);
        empty.style_context().add_class("preview-detail");
        empty.set_no_show_all(true);
        content.add(&empty);
        content.add(&more);
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .build();
        scroll.add(&content);
        root.pack_start(&scroll, true, true, 0);
        Self {
            root,
            entries: RefCell::new(Vec::new()),
            rows,
            state,
            more,
            cursor: RefCell::new(None),
            loaded: Cell::new(false),
            loading: Cell::new(false),
            limit: Cell::new(PAGE_SIZE),
            has_local_more: Cell::new(false),
            expanded: Default::default(),
            empty,
        }
    }
}

type Callback = Rc<dyn Fn(Action)>;

pub struct Extensions {
    pub panel: gtk::Box,
    stack: gtk::Stack,
    search: gtk::SearchEntry,
    refresh: gtk::Button,
    feedback: gtk::Box,
    plugins: Page,
    scopes: gtk::Box,
    featured: gtk::RadioButton,
    installed: gtk::RadioButton,
    all: gtk::RadioButton,
    apps: Page,
    action: RefCell<Option<Callback>>,
    changing: Cell<bool>,
    auth: gtk::Box,
    pending_auth: RefCell<Vec<App>>,
}

impl Extensions {
    pub fn new(host: &str) -> Rc<Self> {
        let panel = gtk::Box::new(gtk::Orientation::Vertical, 6);
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        header.style_context().add_class("sidebar-heading");
        let title = label(&format!("扩展 · {host}"), 1);
        title.set_tooltip_text(Some(host));
        title.style_context().add_class("section-title");
        header.pack_start(&title, true, true, 0);
        let refresh = icons::button(Icon::Refresh, "刷新扩展", "刷新当前主机上的列表");
        header.pack_end(&refresh, false, false, 0);
        panel.add(&header);
        let stack = gtk::Stack::new();
        let switcher = gtk::StackSwitcher::builder()
            .stack(&stack)
            .homogeneous(true)
            .build();
        switcher.style_context().add_class("sidebar-tabs");
        panel.add(&switcher);
        let search = gtk::SearchEntry::builder()
            .placeholder_text("搜索已加载的项目")
            .width_chars(10)
            .build();
        search.style_context().add_class("host-search");
        if let Some(a) = search.accessible() {
            a.set_name("搜索扩展");
        }
        panel.add(&search);
        let feedback = gtk::Box::new(gtk::Orientation::Vertical, 4);
        feedback.style_context().add_class("extensions-feedback");
        feedback.set_no_show_all(true);
        panel.add(&feedback);
        let plugins = Page::new();
        let scopes = gtk::Box::new(gtk::Orientation::Horizontal, 3);
        scopes.set_no_show_all(true);
        let featured = gtk::RadioButton::with_label("精选");
        let installed = gtk::RadioButton::with_label_from_widget(&featured, "已安装");
        let all = gtk::RadioButton::with_label_from_widget(&featured, "全部");
        for button in [&featured, &installed, &all] {
            button.set_mode(false);
            button.style_context().add_class("directory-filter");
            scopes.pack_start(button, false, false, 0);
            button.show();
        }
        plugins.root.pack_start(&scopes, false, false, 0);
        plugins.root.reorder_child(&scopes, 0);
        let apps = Page::new();
        let manage = gtk::Button::with_label("在 ChatGPT 管理授权");
        manage.style_context().add_class("quiet-button");
        manage.set_tooltip_text(Some("在 ChatGPT 的「设置 → 插件」中管理账号授权"));
        manage.connect_clicked(|button| open_link(button, CHATGPT_PLUGINS));
        apps.root.pack_end(&manage, false, false, 0);
        let auth = gtk::Box::new(gtk::Orientation::Vertical, 4);
        auth.style_context().add_class("extensions-feedback");
        auth.set_no_show_all(true);
        apps.root.pack_end(&auth, false, false, 0);
        stack.add_titled(&plugins.root, Section::Plugins.id(), "插件");
        stack.add_titled(&apps.root, Section::Apps.id(), "连接器");
        stack.show_all();
        stack.set_visible_child_name(Section::Plugins.id());
        panel.pack_start(&stack, true, true, 0);
        Rc::new(Self {
            panel,
            stack,
            search,
            refresh,
            feedback,
            plugins,
            scopes,
            featured,
            installed,
            all,
            apps,
            auth,
            action: RefCell::new(None),
            changing: Cell::new(false),
            pending_auth: RefCell::new(Vec::new()),
        })
    }

    pub fn bind(self: &Rc<Self>, action: impl Fn(Action) + 'static) {
        self.action.replace(Some(Rc::new(action)));
        for button in [&self.featured, &self.installed, &self.all] {
            let weak = Rc::downgrade(self);
            button.connect_toggled(move |button| {
                if button.is_active()
                    && let Some(panel) = weak.upgrade()
                {
                    panel.plugins.limit.set(PAGE_SIZE);
                    panel.render(Section::Plugins);
                }
            });
        }
        let weak = Rc::downgrade(self);
        self.stack.connect_visible_child_name_notify(move |_| {
            if let Some(panel) = weak.upgrade() {
                if panel.page(panel.visible()).loaded.get() {
                    panel.render(panel.visible());
                }
                panel.load_visible();
            }
        });
        let weak = Rc::downgrade(self);
        self.refresh.connect_clicked(move |_| {
            if let Some(panel) = weak.upgrade() {
                panel.emit(Action::Load(panel.visible(), true, None));
            }
        });
        let weak = Rc::downgrade(self);
        self.search.connect_search_changed(move |_| {
            if let Some(panel) = weak.upgrade() {
                for section in [Section::Plugins, Section::Apps] {
                    panel.page(section).limit.set(PAGE_SIZE);
                }
                panel.render(panel.visible());
            }
        });
        for section in [Section::Plugins, Section::Apps] {
            let weak = Rc::downgrade(self);
            self.page(section).more.connect_clicked(move |_| {
                if let Some(panel) = weak.upgrade() {
                    let page = panel.page(section);
                    page.limit.set(page.limit.get().saturating_add(PAGE_SIZE));
                    if page.has_local_more.get() {
                        panel.render(section);
                    } else if let Some(cursor) = page.cursor.borrow().clone() {
                        panel.emit(Action::Load(section, false, Some(cursor)));
                    }
                }
            });
        }
    }

    pub fn select(&self, section: Section) {
        self.stack.set_visible_child_name(section.id());
    }

    pub fn load_visible(&self) {
        let section = self.visible();
        if self.panel.is_mapped() && !self.page(section).loaded.get() {
            self.emit(Action::Load(section, false, None));
        }
    }

    pub fn visible(&self) -> Section {
        if self.stack.visible_child_name().as_deref() == Some(Section::Apps.id()) {
            Section::Apps
        } else {
            Section::Plugins
        }
    }

    fn emit(&self, action: Action) {
        let callback = self.action.borrow().clone();
        if let Some(callback) = callback {
            callback(action);
        }
    }

    fn page(&self, section: Section) -> &Page {
        match section {
            Section::Plugins => &self.plugins,
            Section::Apps => &self.apps,
        }
    }

    pub fn begin_list(&self, section: Section) -> bool {
        let page = self.page(section);
        if page.loading.replace(true) {
            return false;
        }
        page.state.set_text("正在读取当前主机的列表…");
        page.state.show();
        page.rows.set_sensitive(false);
        page.more.set_sensitive(false);
        true
    }

    pub fn show_message(&self, section: Section, message: &str) {
        let page = self.page(section);
        page.loading.set(false);
        page.rows.set_sensitive(true);
        page.more.set_sensitive(true);
        page.state.set_text(&limited(message, 400));
        page.state.show();
    }

    pub fn disconnected(&self, message: &str) {
        self.finish_change("");
        self.pending_auth.borrow_mut().clear();
        clear(&self.auth);
        self.auth.hide();
        for section in [Section::Plugins, Section::Apps] {
            let page = self.page(section);
            page.loaded.set(false);
            page.entries.borrow_mut().clear();
            page.expanded.borrow_mut().clear();
            page.limit.set(PAGE_SIZE);
            page.cursor.take();
            self.render(section);
            self.show_message(section, message);
        }
    }

    pub fn update_plugins(&self, plugins: Vec<Plugin>, failures: usize) {
        let empty = plugins.is_empty();
        let featured = plugins.iter().any(|p| p.featured.is_some());
        self.featured.set_sensitive(featured);
        if !self.plugins.loaded.get() || self.featured.is_active() && !featured {
            if featured {
                self.featured.set_active(true);
            } else {
                self.all.set_active(true);
            }
        }
        self.plugins
            .entries
            .replace(plugins.into_iter().map(Entry::Plugin).collect());
        let message = match (empty, failures) {
            (true, 0) => "当前主机未返回插件。".into(),
            (_, 0) => String::new(),
            _ => format!("{failures} 个插件来源加载失败。"),
        };
        self.list_ready(Section::Plugins, &message);
    }

    pub fn update_apps(&self, append: bool, result: &Value) {
        let page = &self.apps;
        let mut entries = page.entries.borrow_mut();
        if !append {
            entries.clear();
        }
        for app in array(&result["data"]).filter_map(App::parse) {
            if let Some(existing) = entries
                .iter_mut()
                .find(|entry| matches!(entry, Entry::App(old) if old.id == app.id))
            {
                *existing = Entry::App(app);
            } else {
                entries.push(Entry::App(app));
            }
        }
        let next = result["nextCursor"].as_str().filter(|cursor| {
            !cursor.is_empty() && (!append || page.cursor.borrow().as_deref() != Some(*cursor))
        });
        page.cursor.replace(next.map(str::to_owned));
        let message = if entries.is_empty() {
            "当前账号未返回连接器。"
        } else {
            ""
        };
        drop(entries);
        self.list_ready(Section::Apps, message);
        self.render_auth();
    }

    fn list_ready(&self, section: Section, message: &str) {
        let page = self.page(section);
        page.loaded.set(true);
        self.show_message(section, message);
        page.state.set_visible(!message.is_empty());
        self.render(section);
    }

    pub fn begin_change(&self, notice: &str) -> bool {
        if self.changing.replace(true) {
            return false;
        }
        self.set_feedback(notice);
        self.refresh.set_sensitive(false);
        self.stack.set_sensitive(false);
        true
    }

    pub fn finish_change(&self, notice: &str) {
        self.changing.set(false);
        self.refresh.set_sensitive(true);
        self.stack.set_sensitive(true);
        self.set_feedback(notice);
    }

    fn set_feedback(&self, notice: &str) {
        clear(&self.feedback);
        self.feedback.set_visible(!notice.is_empty());
        if !notice.is_empty() {
            let message = label(notice, 4);
            self.feedback.add(&message);
            message.show();
        }
    }

    pub fn review(&self, plugin: &Plugin, result: &Value) -> bool {
        let detail = &result["plugin"];
        let mut lines = vec![format!("安装到当前主机 · {}", plugin.source)];
        if let Some(description) = detail["description"].as_str() {
            lines.push(limited(description, 300));
        }
        for (key, heading) in [
            ("apps", "连接器"),
            ("skills", "技能"),
            ("mcpServers", "MCP 服务"),
            ("hooks", "钩子"),
            ("scheduledTasks", "计划任务"),
            ("appTemplates", "连接器模板"),
        ] {
            let names = array(&detail[key])
                .filter_map(|item| {
                    item.as_str()
                        .or_else(|| item["name"].as_str().or(item["eventName"].as_str()))
                })
                .take(8)
                .map(|name| limited(name, 60))
                .collect::<Vec<_>>();
            if !names.is_empty() {
                lines.push(format!("{heading} · {}", names.join("、")));
            }
        }
        let parent = self.panel.toplevel().and_downcast::<gtk::Window>();
        let dialog = gtk::MessageDialog::builder()
            .title("安装插件")
            .modal(true)
            .destroy_with_parent(true)
            .message_type(gtk::MessageType::Question)
            .text(limited(&plugin.title, 160))
            .secondary_text(lines.join("\n"))
            .build();
        dialog.set_transient_for(parent.as_ref());
        dialog.style_context().add_class("workbench-dialog");
        dialog.add_button("取消", gtk::ResponseType::Cancel);
        dialog.add_button("确认安装", gtk::ResponseType::Accept);
        let confirmed = dialog.run() == gtk::ResponseType::Accept;
        dialog.close();
        confirmed
    }

    pub fn show_auth(&self, result: &Value) -> bool {
        let needed = array(&result["appsNeedingAuth"])
            .take(12)
            .filter_map(App::parse)
            .collect::<Vec<_>>();
        if needed.is_empty() {
            return false;
        }
        self.pending_auth.replace(needed);
        self.render_auth();
        true
    }

    fn render_auth(&self) {
        clear(&self.auth);
        let apps = self.apps.entries.borrow();
        let mut pending = self.pending_auth.borrow_mut();
        pending.retain(|app| !apps.iter().any(|entry| matches!(entry, Entry::App(current) if current.id == app.id && current.connected)));
        if pending.is_empty() {
            self.auth.hide();
            return;
        }
        self.auth.add(&label("此插件还有连接器需要授权。", 2));
        for app in pending.iter() {
            if let Some(uri) = &app.url {
                self.auth.add(&link_button(
                    &format!("授权 {}", limited(&app.name, 50)),
                    uri,
                ));
            }
        }
        self.auth.show_all();
        self.auth.show();
    }

    fn render(&self, section: Section) {
        let page = self.page(section);
        clear(&page.rows);
        let query = self.search.text().trim().to_lowercase();
        let Some(action) = self.action.borrow().clone() else {
            return;
        };
        if section == Section::Plugins {
            self.scopes
                .set_visible(query.is_empty() && page.loaded.get());
        }
        let mut matches = 0;
        for entry in page.entries.borrow().iter() {
            let (id, title, description, detail, logo, active) = match entry {
                Entry::Plugin(plugin) => {
                    if query.is_empty()
                        && ((self.featured.is_active() && plugin.featured.is_none())
                            || (self.installed.is_active() && !plugin.installed))
                    {
                        continue;
                    }
                    let status = match (plugin.installed, plugin.enabled, plugin.available) {
                        (true, true, _) => "已安装",
                        (true, false, _) => "已安装 · 已停用",
                        (_, _, false) => "不可安装",
                        _ => "可安装",
                    };
                    (
                        &plugin.id,
                        &plugin.title,
                        &plugin.description,
                        format!("{} · {status}", plugin.source),
                        plugin.logo.as_deref(),
                        plugin.installed && plugin.enabled,
                    )
                }
                Entry::App(app) => {
                    let status = match (app.connected, app.enabled) {
                        (true, true) => "账号可用",
                        (true, false) => "账号可用 · 此主机已停用",
                        (false, _) => "账号尚不可用",
                    };
                    (
                        &app.id,
                        &app.name,
                        &app.description,
                        status.into(),
                        app.logo.as_deref(),
                        app.connected && app.enabled,
                    )
                }
            };
            if !query.is_empty()
                && ![title, description, &detail]
                    .iter()
                    .any(|text| text.to_lowercase().contains(&query))
            {
                continue;
            }
            matches += 1;
            if matches > page.limit.get() {
                break;
            }
            let card = gtk::Box::new(gtk::Orientation::Vertical, 0);
            card.style_context().add_class("extension-card");
            let toggle = gtk::ToggleButton::new();
            toggle.style_context().add_class("extension-item");
            toggle.set_tooltip_text(Some(&format!("查看{title}详情")));
            if let Some(accessible) = toggle.accessible() {
                accessible.set_name(&format!("管理 {title}"));
                accessible.set_description(&format!("{detail} · {description}"));
            }
            let heading = gtk::Box::new(gtk::Orientation::Horizontal, 10);
            heading.pack_start(&crate::extension_art::tile(title, logo), false, false, 0);
            let labels = gtk::Box::new(gtk::Orientation::Vertical, 3);
            labels.set_valign(gtk::Align::Center);
            let title_line = gtk::Box::new(gtk::Orientation::Horizontal, 5);
            title_line.pack_start(&compact_text(title, "extension-title"), true, true, 0);
            let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
            dot.style_context().add_class(if active {
                "extension-active"
            } else {
                "extension-inactive"
            });
            dot.set_valign(gtk::Align::Center);
            dot.set_size_request(6, 6);
            dot.set_tooltip_text(Some(&detail));
            title_line.pack_end(&dot, false, false, 0);
            labels.add(&title_line);
            labels.add(&compact_text(
                if description.is_empty() {
                    &detail
                } else {
                    description
                },
                "extension-subtitle",
            ));
            heading.pack_start(&labels, true, true, 0);
            let open = Rc::new(Cell::new(page.expanded.borrow().contains(id)));
            let arrow_state = open.clone();
            let arrow = icons::changing_widget(12, move || {
                if arrow_state.get() {
                    Icon::ChevronDown
                } else {
                    Icon::ChevronRight
                }
            });
            heading.pack_end(&arrow, false, false, 0);
            toggle.add(&heading);
            card.add(&toggle);
            let body = gtk::Box::new(gtk::Orientation::Vertical, 5);
            body.style_context().add_class("extension-detail");
            let status = label(&detail, 2);
            status.style_context().add_class("extension-state");
            body.add(&status);
            if !description.is_empty() {
                let summary = label(description, 3);
                summary.style_context().add_class("extension-summary");
                body.add(&summary);
            }
            let tools = gtk::Box::new(gtk::Orientation::Horizontal, 5);
            match entry {
                Entry::Plugin(plugin) if plugin.installed => {
                    let id = plugin.id.clone();
                    tools.add(&action_button("卸载", &action, move || {
                        Action::Uninstall(id.clone())
                    }));
                }
                Entry::Plugin(plugin) if plugin.available => {
                    let plugin = plugin.clone();
                    tools.add(&action_button(
                        if plugin.review {
                            "查看并安装"
                        } else {
                            "安装"
                        },
                        &action,
                        move || {
                            if plugin.review {
                                Action::Review(plugin.clone())
                            } else {
                                Action::Install(plugin.clone())
                            }
                        },
                    ));
                }
                Entry::App(app) if app.connected => {
                    if app_key(&app.id).is_some() {
                        let id = app.id.clone();
                        let enable = !app.enabled;
                        tools.add(&action_button(
                            if enable { "启用" } else { "停用" },
                            &action,
                            move || Action::Configure(id.clone(), enable),
                        ));
                    }
                    tools.add(&link_button("管理授权", CHATGPT_PLUGINS));
                }
                Entry::App(app) => {
                    if let Some(uri) = &app.url {
                        tools.add(&link_button("连接", uri));
                    }
                }
                _ => {}
            }
            body.add(&tools);
            card.add(&body);
            page.rows.add(&card);
            card.show_all();
            body.set_no_show_all(true);
            body.set_visible(open.get());
            toggle.set_active(open.get());
            let expanded = page.expanded.clone();
            let id = id.clone();
            toggle.connect_toggled(move |toggle| {
                let active = toggle.is_active();
                body.set_visible(active);
                open.set(active);
                arrow.queue_draw();
                if active {
                    expanded.borrow_mut().insert(id.clone());
                } else {
                    expanded.borrow_mut().remove(&id);
                }
            });
        }
        page.has_local_more.set(matches > page.limit.get());
        let installed_empty =
            section == Section::Plugins && self.installed.is_active() && query.is_empty();
        page.empty.set_text(if installed_empty {
            "此主机还没有已安装的插件"
        } else {
            "没有匹配的项目"
        });
        page.empty.set_visible(
            page.loaded.get() && matches == 0 && (!query.is_empty() || installed_empty),
        );
        page.more
            .set_visible(page.has_local_more.get() || page.cursor.borrow().is_some());
    }
}

pub(crate) fn synopsis(text: Option<&str>) -> String {
    let first = text
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    if first
        .to_ascii_lowercase()
        .starts_with("mcp server instructions")
    {
        return String::new();
    }
    limited(first, 320)
}

fn compact_text(text: &str, class: &str) -> gtk::Label {
    let label = gtk::Label::builder()
        .label(text)
        .xalign(0.0)
        .ellipsize(pango::EllipsizeMode::End)
        .max_width_chars(1)
        .build();
    label.style_context().add_class(class);
    label
}

fn clear(container: &gtk::Box) {
    for child in container.children() {
        container.remove(&child);
    }
}

fn label(text: &str, lines: i32) -> gtk::Label {
    let label = gtk::Label::builder()
        .label(limited(text, 450))
        .xalign(0.0)
        .wrap(true)
        .wrap_mode(pango::WrapMode::WordChar)
        .ellipsize(pango::EllipsizeMode::End)
        .lines(lines)
        .max_width_chars(25)
        .build();
    label.set_tooltip_text((!text.is_empty()).then(|| label.text()).as_deref());
    label
}

fn action_button(
    title: &str,
    action: &Callback,
    build: impl Fn() -> Action + 'static,
) -> gtk::Button {
    let button = gtk::Button::with_label(title);
    button.style_context().add_class("quiet-button");
    let action = action.clone();
    button.connect_clicked(move |_| action(build()));
    button
}

fn link_button(title: &str, uri: &str) -> gtk::Button {
    let button = gtk::Button::with_label(title);
    button.style_context().add_class("quiet-button");
    let uri = uri.to_owned();
    button.connect_clicked(move |button| open_link(button, &uri));
    button
}

fn install_url(item: &Value) -> Option<&str> {
    item["installUrl"]
        .as_str()
        .filter(|uri| web_url(uri) && uri.starts_with("https://"))
}

fn array(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

pub fn app_key(id: &str) -> Option<String> {
    (!id.is_empty()
        && id != "_default"
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then(|| format!("apps.{id}.enabled"))
}
