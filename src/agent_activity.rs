use crate::agent::{append_changes, limited};
use crate::agent_diff::DiffCard;
use crate::agent_render;
use crate::icons::{self, Icon};
use gtk::pango;
use gtk::prelude::*;
use serde_json::Value;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

const SUMMARY_LIMIT: usize = 8 * 1024;
const SUMMARY_PARTS: usize = 24;

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
    summary: Vec<String>,
}

enum View {
    Text(gtk::Label),
    Web {
        detail: gtk::Label,
        source: gtk::LinkButton,
        domain: gtk::Label,
    },
    Command(gtk::Box),
    Patch {
        files: gtk::Label,
        diff: Rc<DiffCard>,
    },
}

pub struct Record<'a> {
    id: &'a str,
    title: String,
    detail: String,
    kind: &'a str,
    icon: Icon,
    status: Option<&'a str>,
    patch: Option<String>,
    summary: Vec<String>,
    web_url: Option<&'a str>,
}

impl<'a> Record<'a> {
    pub fn from_item(item: &'a Value) -> Option<Self> {
        Self::after(item, &[])
    }

    pub fn after(item: &'a Value, earlier: &[String]) -> Option<Self> {
        let id = item["id"].as_str()?;
        let kind = item["type"].as_str()?;
        let status = item["status"].as_str();
        if kind == "fileChange" {
            return Some(Self::patch(id, &item["changes"], status));
        }
        let mut summary = Vec::new();
        let mut web_url = None;
        let (title, detail, icon) = match kind {
            "reasoning" => {
                summary = item["summary"]
                    .as_array()?
                    .iter()
                    .take(SUMMARY_PARTS)
                    .enumerate()
                    .map(|(index, part)| {
                        let part = part.as_str().unwrap_or_default();
                        let tail = earlier.get(index).map_or(part, |prefix| {
                            part.strip_prefix(prefix.as_str()).unwrap_or("")
                        });
                        limited(tail, SUMMARY_LIMIT)
                    })
                    .collect();
                let detail = summary_text(&summary);
                if detail.is_empty() {
                    return None;
                }
                ("推理摘要".into(), detail, Icon::Activity)
            }
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
            id,
            title: with_status(title, status),
            detail,
            kind,
            icon,
            status,
            patch: None,
            summary,
            web_url,
        })
    }

    pub fn id(&self) -> &str {
        self.id
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
            id,
            title: with_status(title, status),
            detail,
            kind: "fileChange",
            icon: Icon::Edit,
            status,
            patch: (!patch.is_empty()).then_some(patch),
            summary: Vec::new(),
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
        set_title_widget(&widget, &heading, &icons::widget(Icon::Activity, 15));
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

    pub fn record(&mut self, record: Record<'_>) {
        self.render_record(record, false);
    }

    pub fn record_history(&mut self, record: Record<'_>) {
        self.render_record(record, true);
    }

    fn render_record(&mut self, record: Record<'_>, historical: bool) {
        let quote = self.quote.clone();
        let entry = self.entry(record.id, record.kind, record.icon);
        set_title(&entry.row, &entry.title, &record.title);
        match &entry.view {
            View::Text(label) if record.kind == "reasoning" => {
                entry.summary = record.summary;
                agent_render::set_markdown(label, &record.detail);
            }
            View::Text(label) => label.set_text(&record.detail),
            View::Web {
                detail,
                source,
                domain,
            } => {
                detail.set_text(&record.detail);
                detail.set_visible(!record.detail.is_empty());
                source.set_visible(record.web_url.is_some());
                if let Some(url) = record.web_url {
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
            View::Command(body) => {
                let status = match record.status {
                    Some("completed") => "成功",
                    Some("failed") => "失败",
                    Some("declined") => "已拒绝",
                    Some("inProgress") => "运行中",
                    _ => "",
                };
                let body = body.clone();
                let detail = record.detail;
                render_detail(&entry.row, historical, move || {
                    for child in body.children() {
                        body.remove(&child);
                    }
                    let card =
                        agent_render::code_card("Shell", &detail, nonempty(Some(status)), &quote);
                    body.add(&card);
                    card.show_all();
                });
            }
            View::Patch { files, diff } => {
                files.set_text(&record.detail);
                if let Some(patch) = record.patch {
                    let diff = diff.clone();
                    let files = files.clone();
                    render_detail(&entry.row, historical, move || {
                        diff.update(&patch);
                        diff.widget().show();
                        files.hide();
                    });
                }
            }
        }
        if !self.finished {
            self.set_heading(&format!("进行中 · {}", record.title));
            self.progress = record.title;
        }
    }

    pub fn summary(&mut self, id: &str, index: usize, delta: &str) {
        let entry = self.entry(id, "reasoning", Icon::Activity);
        set_title(&entry.row, &entry.title, "推理摘要");
        if entry.summary.len() <= index {
            entry.summary.resize_with(index + 1, String::new);
        }
        let part = &mut entry.summary[index];
        if part.len() >= SUMMARY_LIMIT {
            return;
        }
        part.push_str(&limited(delta, SUMMARY_LIMIT - part.len()));
        let detail = summary_text(&entry.summary);
        if let View::Text(label) = &entry.view {
            agent_render::set_markdown(label, &detail);
        }
        self.set_heading("进行中 · 推理摘要");
        if let Some(headline) = detail
            .lines()
            .map(|line| line.trim().trim_matches('*'))
            .find(|line| !line.is_empty())
        {
            self.progress = limited(headline, 180);
        }
    }

    pub fn progress(&self) -> &str {
        &self.progress
    }

    pub fn finish(&mut self, status: Option<&str>) {
        self.finished = true;
        let title = match status {
            Some("inProgress") => "进行中",
            Some("interrupted") => "已停止",
            Some("failed") => "执行失败",
            Some("disconnected") => "连接已断开",
            Some("steered") => "追加前的活动",
            _ => "已完成",
        };
        self.set_heading(&format!("{title} · {} 项活动", self.entries.len()));
    }

    pub fn extend_summary(&self, id: &str, parts: &mut Vec<String>) {
        if let Some(entry) = self.entries.get(id) {
            if parts.len() < entry.summary.len() {
                parts.resize_with(entry.summary.len(), String::new);
            }
            for (old, new) in parts.iter_mut().zip(&entry.summary) {
                old.push_str(new);
            }
        }
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
            let leading = icons::changing_widget(15, move || draw_symbol.get());
            set_title_widget(&item, &title, &leading);
            let view = if kind == "commandExecution" {
                let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
                item.add(&body);
                View::Command(body)
            } else if kind == "fileChange" {
                let body = gtk::Box::new(gtk::Orientation::Vertical, 4);
                let files = agent_render::text("");
                files.style_context().add_class("agent-activity-detail");
                body.add(&files);
                let diff = Rc::new(DiffCard::new("文件补丁"));
                body.add(diff.widget());
                diff.widget().show_all();
                diff.widget().set_no_show_all(true);
                diff.widget().hide();
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
                let detail = if kind == "reasoning" {
                    agent_render::markdown_label()
                } else {
                    agent_render::text("")
                };
                detail.style_context().add_class("agent-activity-detail");
                crate::quote::bind_label(&detail, &self.quote);
                item.add(&detail);
                View::Text(detail)
            };
            if let Some(content) = item.child() {
                content.style_context().add_class("agent-activity-content");
            }
            item.set_expanded(kind == "reasoning");
            self.rows.add(&item);
            item.show_all();
            Entry {
                row: item,
                title,
                icon: symbol,
                leading,
                view,
                summary: Vec::new(),
            }
        });
        if entry.icon.replace(icon) != icon {
            entry.leading.queue_draw();
        }
        entry
    }
}

fn summary_text(parts: &[String]) -> String {
    parts
        .iter()
        .map(String::as_str)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn render_detail(row: &gtk::Expander, deferred: bool, render: impl FnOnce() + 'static) {
    if !deferred || row.is_expanded() {
        render();
        return;
    }
    let render = RefCell::new(Some(render));
    row.connect_expanded_notify(move |row| {
        if row.is_expanded()
            && let Some(render) = render.take()
        {
            render();
        }
    });
}

pub fn summary_delta(params: &Value) -> Option<(&str, usize, &str)> {
    let id = params["itemId"].as_str()?;
    let index = usize::try_from(params["summaryIndex"].as_u64()?).ok()?;
    let delta = nonempty(params["delta"].as_str())?;
    (index < SUMMARY_PARTS).then_some((id, index, delta))
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
    leading.style_context().add_class("agent-activity-icon");
    header.pack_start(leading, false, false, 0);
    header.pack_start(title, false, true, 0);
    let weak = row.downgrade();
    let arrow = icons::changing_widget(12, move || {
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
    title.set_text(text);
    title.set_tooltip_text(Some(text));
    if let Some(accessible) = row.accessible() {
        accessible.set_name(text);
    }
}
