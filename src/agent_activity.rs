use crate::agent::{append_changes, limited};
use crate::agent_diff::DiffCard;
use crate::agent_render;
use gtk::pango;
use gtk::prelude::*;
use serde_json::Value;
use std::{cell::RefCell, collections::HashMap, rc::Rc};

const SUMMARY_LIMIT: usize = 8 * 1024;
const SUMMARY_PARTS: usize = 24;

pub struct Activity {
    pub widget: gtk::Expander,
    heading: gtk::Label,
    rows: gtk::Box,
    entries: HashMap<String, Entry>,
    progress: String,
}

struct Entry {
    row: gtk::Expander,
    title: gtk::Label,
    view: View,
    summary: Vec<String>,
}

enum View {
    Text(gtk::Label),
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
    status: Option<&'a str>,
    patch: Option<String>,
}

impl<'a> Record<'a> {
    pub fn from_item(item: &'a Value) -> Option<Self> {
        let id = item["id"].as_str()?;
        let kind = item["type"].as_str()?;
        let status = item["status"].as_str();
        if kind == "fileChange" {
            return Some(Self::patch(id, &item["changes"], status));
        }
        let (title, detail) = match kind {
            "reasoning" => {
                let summary = item["summary"]
                    .as_array()?
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|part| !part.is_empty())
                    .take(SUMMARY_PARTS)
                    .map(|part| limited(part, SUMMARY_LIMIT))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if summary.is_empty() {
                    return None;
                }
                ("推理摘要".into(), summary)
            }
            "commandExecution" => command(item),
            "webSearch" => {
                let action = &item["action"];
                let (verb, target) = match action["type"].as_str() {
                    Some("openPage") => ("打开网页", action["url"].as_str()),
                    Some("findInPage") => ("在网页中查找", action["pattern"].as_str()),
                    _ => (
                        "搜索网页",
                        nonempty(item["query"].as_str()).or_else(|| action["query"].as_str()),
                    ),
                };
                (
                    brief(verb, target),
                    target.map_or_else(String::new, |v| limited(v, 2048)),
                )
            }
            "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall" => (
                brief("调用工具", item["tool"].as_str()),
                item["server"]
                    .as_str()
                    .map_or_else(String::new, |v| limited(v, 256)),
            ),
            "imageView" => (brief("查看图片", item["path"].as_str()), String::new()),
            _ => return None,
        };
        Some(Self {
            id,
            title: with_status(title, status),
            detail,
            kind,
            status,
            patch: None,
        })
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
            status,
            patch: (!patch.is_empty()).then_some(patch),
        }
    }
}

impl Activity {
    pub fn new() -> Self {
        let widget = gtk::Expander::new(None);
        widget.style_context().add_class("agent-activity");
        let heading = title_label();
        heading.style_context().add_class("agent-activity-heading");
        widget.set_label_widget(Some(&heading));
        let rows = gtk::Box::new(gtk::Orientation::Vertical, 4);
        rows.style_context().add_class("agent-activity-rows");
        widget.add(&rows);
        Self {
            widget,
            heading,
            rows,
            entries: HashMap::new(),
            progress: String::new(),
        }
    }

    pub fn record(&mut self, record: Record<'_>) {
        self.render_record(record, false);
    }

    pub fn record_history(&mut self, record: Record<'_>) {
        self.render_record(record, true);
    }

    fn render_record(&mut self, record: Record<'_>, historical: bool) {
        let entry = self.entry(record.id, record.kind);
        entry.title.set_text(&record.title);
        entry.title.set_tooltip_text(Some(&record.title));
        match &entry.view {
            View::Text(label) if record.kind == "reasoning" => {
                agent_render::set_markdown(label, &record.detail);
            }
            View::Text(label) => label.set_text(&record.detail),
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
                    let card = agent_render::code_card("Shell", &detail, nonempty(Some(status)));
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
        self.set_heading(&format!("进行中 · {}", record.title));
        self.progress = record.title;
    }

    pub fn summary(&mut self, id: &str, index: usize, delta: &str) {
        let entry = self.entry(id, "reasoning");
        entry.title.set_text("推理摘要");
        if entry.summary.len() <= index {
            entry.summary.resize_with(index + 1, String::new);
        }
        let part = &mut entry.summary[index];
        if part.len() >= SUMMARY_LIMIT {
            return;
        }
        part.push_str(&limited(delta, SUMMARY_LIMIT - part.len()));
        let detail = entry.summary.join("\n\n");
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

    pub fn finish(&self, status: Option<&str>) {
        let title = match status {
            Some("inProgress") => "进行中",
            Some("interrupted") => "已停止",
            Some("failed") => "执行失败",
            Some("disconnected") => "连接已断开",
            _ => "已完成",
        };
        self.set_heading(&format!("{title} · {} 项活动", self.entries.len()));
    }

    fn set_heading(&self, text: &str) {
        self.heading.set_text(text);
        self.heading.set_tooltip_text(Some(text));
    }

    fn entry(&mut self, id: &str, kind: &str) -> &mut Entry {
        self.entries.entry(id.to_owned()).or_insert_with(|| {
            let item = gtk::Expander::new(None);
            item.style_context().add_class("agent-activity-row");
            let title = title_label();
            item.set_label_widget(Some(&title));
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
            } else {
                let detail = if kind == "reasoning" {
                    agent_render::markdown_label()
                } else {
                    agent_render::text("")
                };
                detail.style_context().add_class("agent-activity-detail");
                item.add(&detail);
                View::Text(detail)
            };
            item.set_expanded(kind == "reasoning");
            self.rows.add(&item);
            item.show_all();
            Entry {
                row: item,
                title,
                view,
                summary: Vec::new(),
            }
        })
    }
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

fn command(item: &Value) -> (String, String) {
    let command = item["command"].as_str().unwrap_or("");
    let action = item["commandActions"]
        .as_array()
        .filter(|actions| actions.len() == 1)
        .map(|actions| &actions[0]);
    let title = match action {
        Some(action) if action["type"] == "read" => brief(
            "读取文件",
            action["path"].as_str().or_else(|| action["name"].as_str()),
        ),
        Some(action) if action["type"] == "listFiles" => brief("列出文件", action["path"].as_str()),
        Some(action) if action["type"] == "search" => brief(
            "搜索代码",
            action["query"].as_str().or_else(|| action["path"].as_str()),
        ),
        _ => brief("运行命令", Some(command)),
    };
    let mut detail = format!("$ {}", limited(command, 2048));
    if let Some(code) = item["exitCode"].as_i64() {
        detail.push_str(&format!("\n退出码 {code}"));
    }
    if let Some(output) = nonempty(item["aggregatedOutput"].as_str()) {
        detail.push_str("\n\n");
        detail.push_str(&limited(output, 24 * 1024));
    }
    (title, detail)
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
    label.set_hexpand(true);
    label.set_ellipsize(pango::EllipsizeMode::End);
    label
}
