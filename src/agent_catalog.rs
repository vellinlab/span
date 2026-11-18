use crate::agent_render;
use gtk::prelude::*;
use gtk::{glib, pango};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashSet;

#[derive(Clone)]
pub struct Entry {
    pub id: String,
    pub project: String,
    pub title: String,
    pub state: String,
}

impl Entry {
    fn parse(value: &Value) -> Option<Self> {
        let id = value["id"].as_str()?.to_owned();
        let project = value["cwd"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("未指定目录");
        let title = ["name", "preview"]
            .into_iter()
            .filter_map(|field| value[field].as_str())
            .find(|title| !title.trim().is_empty())
            .unwrap_or("未命名会话");
        let state = match value["status"]["type"].as_str() {
            Some("active")
                if value["status"]["activeFlags"]
                    .as_array()
                    .is_some_and(|flags| !flags.is_empty()) =>
            {
                "等待输入"
            }
            Some("active") => "运行中",
            Some("systemError") => "异常",
            _ => "",
        };
        Some(Self {
            id,
            project: project.replace('\0', "�"),
            title: title
                .lines()
                .next()
                .unwrap_or(title)
                .replace('\0', "�")
                .chars()
                .take(200)
                .collect(),
            state: state.to_owned(),
        })
    }
}

pub struct Catalog {
    pub popover: gtk::Popover,
    pub search: gtk::SearchEntry,
    pub archived: gtk::CheckButton,
    pub more: gtk::Button,
    pub refresh: gtk::Button,
    pub new_thread: gtk::Button,
    status: gtk::Label,
    list: gtk::ListBox,
    entries: RefCell<Vec<Entry>>,
    cursor: RefCell<Option<String>>,
}

impl Catalog {
    pub fn new(anchor: &gtk::Button, host: &str) -> Self {
        let popover = gtk::Popover::new(Some(anchor));
        popover.set_position(gtk::PositionType::Bottom);
        let column = gtk::Box::new(gtk::Orientation::Vertical, 8);
        column.style_context().add_class("agent-catalog");
        column.set_width_request(370);
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let title = agent_render::text(&format!("{} · Codex 会话", host));
        title.set_selectable(false);
        title.style_context().add_class("agent-title");
        header.pack_start(&title, true, true, 0);
        let new_thread = gtk::Button::with_label("新建");
        header.pack_end(&new_thread, false, false, 0);
        column.add(&header);

        let search = gtk::SearchEntry::builder()
            .placeholder_text("搜索会话标题")
            .build();
        column.add(&search);
        let filters = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let archived = gtk::CheckButton::with_label("已归档");
        let refresh = gtk::Button::with_label("刷新");
        filters.pack_start(&archived, true, true, 0);
        filters.pack_end(&refresh, false, false, 0);
        column.add(&filters);

        let list = gtk::ListBox::new();
        list.style_context().add_class("agent-catalog-list");
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .height_request(290)
            .build();
        scroll.add(&list);
        column.add(&scroll);
        let status = gtk::Label::new(Some("正在读取会话…"));
        status.set_xalign(0.0);
        status.set_ellipsize(pango::EllipsizeMode::End);
        let more = gtk::Button::with_label("加载更多");
        more.set_sensitive(false);
        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        footer.pack_start(&status, true, true, 0);
        footer.pack_end(&more, false, false, 0);
        column.add(&footer);
        popover.add(&column);
        column.show_all();
        Self {
            popover,
            search,
            archived,
            more,
            refresh,
            new_thread,
            status,
            list,
            entries: RefCell::new(Vec::new()),
            cursor: RefCell::new(None),
        }
    }

    pub fn on_activate(&self, f: impl Fn(usize) + 'static) {
        let f = std::rc::Rc::new(f);
        let activate = f.clone();
        self.list.connect_row_activated(move |_, row| {
            if let Some(index) = row
                .widget_name()
                .strip_prefix("thread-")
                .and_then(|suffix| suffix.parse::<usize>().ok())
            {
                activate(index);
            }
        });
        let list = self.list.downgrade();
        self.search.connect_activate(move |search| {
            let Some(list) = list.upgrade() else {
                return;
            };
            if !search.text().trim().is_empty() && list.children().len() == 2 {
                f(0);
            }
        });
    }

    pub fn entry(&self, index: usize) -> Option<Entry> {
        self.entries.borrow().get(index).cloned()
    }

    pub fn cursor(&self) -> Option<String> {
        self.cursor.borrow().clone()
    }

    pub fn loading(&self, fresh: bool) {
        if fresh {
            self.entries.borrow_mut().clear();
            self.cursor.take();
            for child in self.list.children() {
                self.list.remove(&child);
            }
        }
        self.more.set_sensitive(false);
        self.show_status("正在读取会话…");
    }

    pub fn show_status(&self, status: &str) {
        let status = status.replace('\0', "�");
        self.status.set_text(&status);
        self.status.set_tooltip_text(Some(&status));
        self.more
            .set_sensitive(self.cursor.borrow().is_some() && status != "正在读取会话…");
    }

    pub fn update(&self, result: &Value) {
        let mut entries = self.entries.borrow_mut();
        let mut seen: HashSet<_> = entries.iter().map(|entry| entry.id.clone()).collect();
        if let Some(data) = result["data"].as_array() {
            entries.extend(
                data.iter()
                    .filter_map(Entry::parse)
                    .filter(|entry| seen.insert(entry.id.clone())),
            );
        }
        self.cursor
            .replace(result["nextCursor"].as_str().map(str::to_owned));
        for child in self.list.children() {
            self.list.remove(&child);
        }
        let mut groups: Vec<(&str, Vec<usize>)> = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            if let Some((_, items)) = groups
                .iter_mut()
                .find(|(project, _)| *project == entry.project)
            {
                items.push(index);
            } else {
                groups.push((&entry.project, vec![index]));
            }
        }
        for (project, items) in groups {
            let heading = gtk::ListBoxRow::new();
            heading.set_activatable(false);
            heading.set_selectable(false);
            let label = gtk::Label::new(Some(project));
            label.set_xalign(0.0);
            label.set_ellipsize(pango::EllipsizeMode::Start);
            label.set_tooltip_text(Some(project));
            label.style_context().add_class("agent-catalog-project");
            heading.add(&label);
            self.list.add(&heading);
            for index in items {
                let entry = &entries[index];
                let row = gtk::ListBoxRow::new();
                row.set_widget_name(&format!("thread-{index}"));
                row.set_tooltip_text(Some(&entry.title));
                let line = gtk::Box::new(gtk::Orientation::Horizontal, 6);
                let title = gtk::Label::new(Some(&entry.title));
                title.set_xalign(0.0);
                title.set_ellipsize(pango::EllipsizeMode::End);
                line.pack_start(&title, true, true, 0);
                if !entry.state.is_empty() {
                    let state = gtk::Label::new(Some(&entry.state));
                    state.style_context().add_class("agent-status");
                    line.pack_end(&state, false, false, 0);
                }
                row.add(&line);
                self.list.add(&row);
            }
        }
        self.list.show_all();
        self.show_status(if entries.is_empty() {
            "没有匹配的会话"
        } else {
            "点击会话继续"
        });
    }
}

pub fn wire_params(search: &glib::GString, archived: bool, cursor: Option<String>) -> Value {
    let search = search.trim();
    serde_json::json!({
        "limit": 30, "sortKey": "updated_at", "archived": archived,
        "cursor": cursor, "searchTerm": (!search.is_empty()).then_some(search)
    })
}
