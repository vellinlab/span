use crate::agent::{append_changes, limited};
use crate::agent_diff::FoldedDiff;
use crate::agent_render;
use crate::icons::{self, Icon};
use gtk::prelude::*;
use gtk::{glib, pango};
use serde_json::Value;
use std::borrow::Cow;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

pub struct Activity {
    pub widget: gtk::Expander,
    heading: gtk::Label,
    rows: gtk::Box,
    entries: HashMap<String, Entry>,
    progress: String,
    finished: bool,
    quote: crate::quote::Action,
}

struct Entry {
    row: gtk::Expander,
    title: gtk::Label,
    icon: Rc<Cell<Icon>>,
    leading: gtk::DrawingArea,
    view: View,
}

enum View {
    Text(gtk::Label),
    Web {
        detail: gtk::Label,
        source: gtk::LinkButton,
        domain: gtk::Label,
    },
    Command {
        body: gtk::Box,
        detail: FoldedDetail,
    },
    Patch {
        files: gtk::Label,
        diff: FoldedDiff,
    },
}

pub struct Record<'a> {
    id: Cow<'a, str>,
    title: String,
    detail: String,
    kind: Cow<'a, str>,
    icon: Icon,
    status: Option<Cow<'a, str>>,
    patch: Option<String>,
    web_url: Option<Cow<'a, str>>,
}

impl<'a> Record<'a> {
    pub fn from_item(item: &'a Value) -> Option<Self> {
        let id = item["id"].as_str()?;
        let kind = item["type"].as_str()?;
        let status = item["status"].as_str();
        if kind == "fileChange" {
            return Some(Self::patch(id, &item["changes"], status));
        }
        let mut web_url = None;
        let (title, detail, icon) = match kind {
            "commandExecution" => command(item),
            "webSearch" => {
                let action = &item["action"];
                web_url = action["url"]
                    .as_str()
                    .filter(|url| agent_render::web_url(url));
                let (verb, target, icon) = match action["type"].as_str() {
                    Some("openPage") => ("打开网页", action["url"].as_str(), Icon::Globe),
                    Some("findInPage") => {
                        ("在网页中查找", action["pattern"].as_str(), Icon::Search)
                    }
                    _ => (
                        "搜索网页",
                        nonempty(item["query"].as_str()).or_else(|| action["query"].as_str()),
                        Icon::Search,
                    ),
                };
                let detail = action["queries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|query| Some(*query) != target)
                    .take(10)
                    .map(|query| limited(query, 240))
                    .collect::<Vec<_>>()
                    .join("\n");
                (brief(verb, target), detail, icon)
            }
            "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall" => (
                brief("调用工具", item["tool"].as_str()),
                item["server"]
                    .as_str()
                    .map_or_else(String::new, |v| limited(v, 256)),
                Icon::Tool,
            ),
            "imageView" => (
                brief("查看图片", item["path"].as_str()),
                String::new(),
                Icon::File,
            ),
            _ => return None,
        };
        Some(Self {
            id: id.into(),
            title: with_status(title, status),
            detail,
            kind: kind.into(),
            icon,
            status: status.map(Cow::Borrowed),
            patch: None,
            web_url: web_url.map(Cow::Borrowed),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    fn into_owned(self) -> Record<'static> {
        Record {
            id: Cow::Owned(self.id.into_owned()),
            title: self.title,
            detail: self.detail,
            kind: Cow::Owned(self.kind.into_owned()),
            icon: self.icon,
            status: self.status.map(|status| Cow::Owned(status.into_owned())),
            patch: self.patch,
            web_url: self.web_url.map(|url| Cow::Owned(url.into_owned())),
        }
    }

    pub fn patch(id: &'a str, changes: &Value, status: Option<&'a str>) -> Self {
        let paths = changes.as_array();
        let count = paths.map_or(0, Vec::len);
        let detail = paths
            .into_iter()
            .flatten()
            .filter_map(|change| change["path"].as_str())
            .take(100)
            .map(|path| limited(path, 512))
            .collect::<Vec<_>>()
            .join("\n");
        let title = if count == 1 {
            brief("修改文件", Some(&detail))
        } else {
            format!("修改文件 · {count} 项")
        };
        let mut patch = String::new();
        append_changes(changes, &mut patch);
        Self {
            id: id.into(),
            title: with_status(title, status),
            detail,
            kind: Cow::Borrowed("fileChange"),
            icon: Icon::Edit,
            status: status.map(Cow::Borrowed),
            patch: (!patch.is_empty()).then_some(patch),
            web_url: None,
        }
    }
}

impl Activity {
    pub fn new(quote: crate::quote::Action) -> Self {
        let widget = gtk::Expander::new(None);
        widget.style_context().add_class("agent-activity");
        let heading = title_label();
        heading.style_context().add_class("agent-activity-heading");
        let leading = icons::aligned_widget(15, &heading, || Icon::Activity);
        set_title_widget(&widget, &heading, &leading);
        let rows = gtk::Box::new(gtk::Orientation::Vertical, 3);
        rows.style_context().add_class("agent-activity-rows");
        widget.add(&rows);
        Self {
            widget,
            heading,
            rows,
            entries: HashMap::new(),
            progress: String::new(),
            finished: false,
            quote,
        }
    }

    pub fn archived(
        quote: crate::quote::Action,
        records: Vec<Record<'_>>,
        status: Option<&str>,
    ) -> gtk::Expander {
        let activity = Self::new(quote.clone());
        let count = records
            .iter()
            .map(Record::id)
            .collect::<std::collections::HashSet<_>>()
            .len();
        activity.set_finished_heading(status, count);
        let records = RefCell::new(Some(
            records
                .into_iter()
                .map(Record::into_owned)
                .collect::<Vec<_>>(),
        ));
        let heading = activity.heading.downgrade();
        let rows = activity.rows.downgrade();
        activity.widget.connect_expanded_notify(move |widget| {
            if !widget.is_expanded() {
                return;
            }
            let (Some(heading), Some(rows), Some(records)) =
                (heading.upgrade(), rows.upgrade(), records.take())
            else {
                return;
            };
            let mut activity = Self {
                widget: widget.clone(),
                heading,
                rows,
                entries: HashMap::new(),
                progress: String::new(),
                finished: true,
                quote: quote.clone(),
            };
            for record in records {
                activity.record(record);
            }
        });
        activity.widget
    }

    pub fn record(&mut self, record: Record<'_>) {
        let quote = self.quote.clone();
        let entry = self.entry(&record.id, &record.kind, record.icon);
        set_title(&entry.row, &entry.title, &record.title);
        match &entry.view {
            View::Text(label) => label.set_text(&record.detail),
            View::Web {
                detail,
                source,
                domain,
            } => {
                detail.set_text(&record.detail);
                detail.set_visible(!record.detail.is_empty());
                source.set_visible(record.web_url.is_some());
                if let Some(url) = record.web_url.as_deref() {
                    let host = url
                        .split_once("://")
                        .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
                        .map(|host| host.rsplit('@').next().unwrap_or(host))
                        .filter(|host| !host.is_empty())
                        .unwrap_or(url);
                    domain.set_text(host);
                    source.set_uri(url);
                    source.set_tooltip_text(Some(url));
                    if let Some(accessible) = source.accessible() {
                        accessible.set_name(&format!("打开网页 · {host}"));
                    }
                }
            }
            View::Command { body, detail } => {
                let status = match record.status.as_deref() {
                    Some("completed") => "成功",
                    Some("failed") => "失败",
                    Some("declined") => "已拒绝",
                    Some("inProgress") => "运行中",
                    _ => "",
                };
                let body = body.clone();
                let output = record.detail;
                detail.update(&entry.row, move || {
                    for child in body.children() {
                        body.remove(&child);
                    }
                    let card =
                        agent_render::code_card("Shell", &output, nonempty(Some(status)), &quote);
                    body.add(&card);
                    card.show_all();
                });
            }
            View::Patch { files, diff } => {
                files.set_text(&record.detail);
                if let Some(patch) = record.patch {
                    diff.update(&entry.row, patch);
                }
            }
        }
        if !self.finished {
            self.set_heading(&format!("进行中 · {}", record.title));
            self.progress = record.title;
        }
    }

    pub fn progress(&self) -> &str {
        &self.progress
    }

    pub fn finish(&mut self, status: Option<&str>) {
        self.finished = true;
        self.set_finished_heading(status, self.entries.len());
    }

    fn set_finished_heading(&self, status: Option<&str>, count: usize) {
        let title = match status {
            Some("inProgress") => "进行中",
            Some("interrupted") => "已停止",
            Some("failed") => "执行失败",
            Some("disconnected") => "连接已断开",
            Some("steered") => "追加前的活动",
            _ => "已完成",
        };
        self.set_heading(&format!("{title} · {count} 项活动"));
    }

    pub fn has_item(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    fn set_heading(&self, text: &str) {
        set_title(&self.widget, &self.heading, text);
    }

    fn entry(&mut self, id: &str, kind: &str, icon: Icon) -> &mut Entry {
        let entry = self.entries.entry(id.to_owned()).or_insert_with(|| {
            let item = gtk::Expander::new(None);
            item.style_context().add_class("agent-activity-row");
            let title = title_label();
            let symbol = Rc::new(Cell::new(icon));
            let draw_symbol = symbol.clone();
            let leading = icons::aligned_widget(15, &title, move || draw_symbol.get());
            set_title_widget(&item, &title, &leading);
            let view = if kind == "commandExecution" {
                let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
                item.add(&body);
                View::Command {
                    body,
                    detail: FoldedDetail::new(&item),
                }
            } else if kind == "fileChange" {
                let body = gtk::Box::new(gtk::Orientation::Vertical, 4);
                let files = agent_render::text("");
                files.style_context().add_class("agent-activity-detail");
                body.add(&files);
                let diff = FoldedDiff::new(&item, &body, "文件补丁", Some(&files));
                item.add(&body);
                View::Patch { files, diff }
            } else if kind == "webSearch" {
                let body = gtk::Box::new(gtk::Orientation::Vertical, 4);
                body.style_context().add_class("agent-activity-web");
                let detail = agent_render::text("");
                detail.style_context().add_class("agent-activity-detail");
                detail.set_no_show_all(true);
                let source = gtk::LinkButton::with_label("", "");
                source.style_context().add_class("agent-source-link");
                source.set_halign(gtk::Align::Start);
                source.set_focus_on_click(false);
                if let Some(label) = source.child() {
                    source.remove(&label);
                }
                let content = gtk::Box::new(gtk::Orientation::Horizontal, 6);
                let domain = gtk::Label::new(None);
                domain.set_ellipsize(pango::EllipsizeMode::Middle);
                domain.set_max_width_chars(44);
                content.pack_start(&domain, true, true, 0);
                content.pack_start(&icons::widget(Icon::ExternalLink, 13), false, false, 0);
                source.add(&content);
                content.show_all();
                source.connect_activate_link(|button| {
                    if let Some(uri) = button.uri() {
                        agent_render::open_link(button, &uri);
                    }
                    gtk::glib::Propagation::Stop
                });
                source.set_no_show_all(true);
                body.add(&detail);
                body.add(&source);
                item.add(&body);
                View::Web {
                    detail,
                    source,
                    domain,
                }
            } else {
                let detail = agent_render::text("");
                detail.style_context().add_class("agent-activity-detail");
                crate::quote::bind_label(&detail, &self.quote);
                item.add(&detail);
                View::Text(detail)
            };
            if let Some(content) = item.child() {
                content.style_context().add_class("agent-activity-content");
            }
            self.rows.add(&item);
            item.show_all();
            Entry {
                row: item,
                title,
                icon: symbol,
                leading,
                view,
            }
        });
        if entry.icon.replace(icon) != icon {
            entry.leading.queue_draw();
        }
        entry
    }
}

type PendingDetail = Rc<RefCell<Option<Box<dyn FnOnce()>>>>;

pub struct FoldedDetail(PendingDetail);

impl FoldedDetail {
    pub fn new(row: &gtk::Expander) -> Self {
        let pending: PendingDetail = Rc::default();
        let on_expand = pending.clone();
        row.connect_expanded_notify(move |row| {
            if row.is_expanded()
                && let Some(render) = on_expand.take()
            {
                render();
            }
        });
        Self(pending)
    }

    pub fn update(&self, row: &gtk::Expander, render: impl FnOnce() + 'static) {
        if row.is_expanded() {
            self.0.take();
            render();
        } else {
            // File changes and command output are snapshots. Only the most recent
            // snapshot is needed when the user opens this row.
            self.0.replace(Some(Box::new(render)));
        }
    }
}

fn command(item: &Value) -> (String, String, Icon) {
    let command = item["command"].as_str().unwrap_or("");
    let action = item["commandActions"]
        .as_array()
        .filter(|actions| actions.len() == 1)
        .map(|actions| &actions[0]);
    let (title, icon) = match action {
        Some(action) if action["type"] == "read" => (
            brief(
                "读取文件",
                action["path"].as_str().or_else(|| action["name"].as_str()),
            ),
            Icon::Book,
        ),
        Some(action) if action["type"] == "listFiles" => {
            (brief("列出文件", action["path"].as_str()), Icon::Folder)
        }
        Some(action) if action["type"] == "search" => (
            brief(
                "搜索代码",
                action["query"].as_str().or_else(|| action["path"].as_str()),
            ),
            Icon::Search,
        ),
        _ => (brief("运行命令", Some(command)), Icon::Terminal),
    };
    let mut detail = format!("$ {}", limited(command, 2048));
    if let Some(code) = item["exitCode"].as_i64() {
        detail.push_str(&format!("\n退出码 {code}"));
    }
    if let Some(output) = nonempty(item["aggregatedOutput"].as_str()) {
        detail.push_str("\n\n");
        detail.push_str(&limited(output, 24 * 1024));
    }
    (title, detail, icon)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

fn with_status(title: String, status: Option<&str>) -> String {
    match status {
        Some("inProgress") => format!("{title}…"),
        Some("failed") => format!("{title} · 失败"),
        Some("declined") => format!("{title} · 已拒绝"),
        _ => title,
    }
}

fn brief(verb: &str, target: Option<&str>) -> String {
    nonempty(target).map_or_else(
        || verb.into(),
        |target| {
            let line = target.lines().next().unwrap_or_default();
            format!("{verb} · {}", limited(line, 240).replace('\n', ""))
        },
    )
}

fn title_label() -> gtk::Label {
    let label = gtk::Label::new(None);
    label.set_xalign(0.0);
    label.set_ellipsize(pango::EllipsizeMode::End);
    label
}

fn set_title_widget(row: &gtk::Expander, title: &gtk::Label, leading: &gtk::DrawingArea) {
    let header = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    header.style_context().add_class("agent-activity-title");
    title.set_valign(gtk::Align::Center);
    leading.style_context().add_class("agent-activity-icon");
    header.pack_start(leading, false, false, 0);
    header.pack_start(title, false, true, 0);
    let weak = row.downgrade();
    let arrow = icons::aligned_widget(12, title, move || {
        if weak.upgrade().is_some_and(|row| row.is_expanded()) {
            Icon::ChevronDown
        } else {
            Icon::ChevronRight
        }
    });
    arrow.style_context().add_class("agent-activity-disclosure");
    header.pack_end(&arrow, false, false, 0);
    row.connect_expanded_notify(move |_| arrow.queue_draw());
    row.set_label_widget(Some(&header));
}

fn set_title(row: &gtk::Expander, title: &gtk::Label, text: &str) {
    if title.text().as_str() == text {
        return;
    }
    title.set_text(text);
    title.set_tooltip_text(Some(text));
    if let Some(accessible) = row.accessible() {
        accessible.set_name(text);
    }
}
