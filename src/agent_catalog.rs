use crate::agent_render;
use crate::icons::{self, Icon};
use gtk::prelude::*;
use gtk::{glib, pango};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashSet;

#[derive(Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub project: String,
    pub title: String,
    state: ThreadState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ThreadState {
    Idle,
    Ready,
    Running,
    Waiting,
    Stopped,
    Error,
}

impl ThreadState {
    fn appearance(self) -> (&'static str, &'static str) {
        match self {
            Self::Idle => ("dot-idle", "未打开"),
            Self::Ready => ("dot-ready", "就绪"),
            Self::Running => ("dot-running", "运行中"),
            Self::Waiting => ("dot-waiting", "等待输入"),
            Self::Stopped => ("dot-waiting", "已中断"),
            Self::Error => ("dot-error", "异常"),
        }
    }
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
                ThreadState::Waiting
            }
            Some("active") => ThreadState::Running,
            Some("systemError") => ThreadState::Error,
            _ => ThreadState::Idle,
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
            state,
        })
    }
}

pub struct Catalog {
    pub panel: gtk::Box,
    pub search: gtk::SearchEntry,
    pub archived: gtk::CheckButton,
    pub more: gtk::Button,
    pub refresh: gtk::Button,
    pub new_thread: gtk::Button,
    status: gtk::Label,
    list: gtk::ListBox,
    entries: RefCell<Vec<Entry>>,
    rows: RefCell<Vec<Option<SessionRow>>>,
    current: RefCell<Option<(String, ThreadState)>>,
    cursor: RefCell<Option<String>>,
}

struct SessionRow {
    widget: gtk::ListBoxRow,
    dot: gtk::Box,
}

impl Catalog {
    pub fn new(host: &str) -> Self {
        let column = gtk::Box::new(gtk::Orientation::Vertical, 8);
        column.style_context().add_class("agent-catalog");
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let title = agent_render::text(host);
        title.set_selectable(false);
        title.set_ellipsize(pango::EllipsizeMode::End);
        title.style_context().add_class("agent-title");
        header.pack_start(&title, true, true, 0);
        let new_thread = gtk::Button::with_label("新建");
        new_thread.style_context().add_class("quiet-button");
        header.pack_end(&new_thread, false, false, 0);
        column.add(&header);

        let search = gtk::SearchEntry::builder()
            .placeholder_text("搜索会话标题")
            .width_chars(12)
            .build();
        column.add(&search);
        let filters = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let archived = gtk::CheckButton::with_label("已归档");
        let refresh = gtk::Button::with_label("刷新");
        refresh.style_context().add_class("quiet-button");
        filters.pack_start(&archived, true, true, 0);
        filters.pack_end(&refresh, false, false, 0);
        column.add(&filters);

        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::None);
        list.style_context().add_class("agent-catalog-list");
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .overlay_scrolling(false)
            .kinetic_scrolling(false)
            .build();
        scroll.add(&list);
        column.pack_start(&scroll, true, true, 0);
        let status = gtk::Label::new(Some("正在读取会话…"));
        status.set_xalign(0.0);
        status.set_ellipsize(pango::EllipsizeMode::End);
        let more = gtk::Button::with_label("加载更多");
        more.style_context().add_class("quiet-button");
        more.set_sensitive(false);
        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        footer.pack_start(&status, true, true, 0);
        footer.pack_end(&more, false, false, 0);
        column.add(&footer);
        Self {
            panel: column,
            search,
            archived,
            more,
            refresh,
            new_thread,
            status,
            list,
            entries: RefCell::new(Vec::new()),
            rows: RefCell::new(Vec::new()),
            current: RefCell::new(None),
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
            self.rows.borrow_mut().clear();
            self.cursor.take();
            for child in self.list.children() {
                self.list.remove(&child);
            }
        }
        self.more.set_sensitive(false);
        self.show_status("正在读取会话…");
    }

    pub fn set_current(&self, id: Option<&str>, state: ThreadState) {
        let mut current = self.current.borrow_mut();
        if current.as_ref().map(|(id, state)| (id.as_str(), *state)) == id.map(|id| (id, state)) {
            return;
        }
        let previous = std::mem::replace(&mut *current, id.map(|id| (id.to_owned(), state)));
        let rows = self.rows.borrow();
        for (entry, row) in self.entries.borrow().iter().zip(rows.iter()) {
            if let Some(row) = row
                && (id == Some(entry.id.as_str())
                    || previous.as_ref().is_some_and(|(old, _)| old == &entry.id))
            {
                row.update(entry, current.as_ref());
            }
        }
    }

    pub fn show_status(&self, status: &str) {
        let status = status.replace('\0', "�");
        self.status.set_text(&status);
        self.status.set_tooltip_text(Some(&status));
        self.more
            .set_sensitive(self.cursor.borrow().is_some() && status != "正在读取会话…");
    }

    pub fn update(&self, result: &Value, replace: bool) {
        let mut entries = self.entries.borrow_mut();
        let mut next = if replace { Vec::new() } else { entries.clone() };
        let mut seen: HashSet<_> = next.iter().map(|entry| entry.id.clone()).collect();
        if let Some(data) = result["data"].as_array() {
            next.extend(
                data.iter()
                    .filter_map(Entry::parse)
                    .filter(|entry| seen.insert(entry.id.clone())),
            );
        }
        self.cursor
            .replace(result["nextCursor"].as_str().map(str::to_owned));
        self.show_status(if next.is_empty() {
            "没有匹配的会话"
        } else {
            "点击会话继续"
        });
        if *entries == next {
            return;
        }
        *entries = next;
        let current = self.current.borrow();
        let mut rows = self.rows.borrow_mut();
        rows.clear();
        rows.resize_with(entries.len(), || None);
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
            heading.style_context().add_class("agent-catalog-section");
            heading.set_activatable(false);
            heading.set_selectable(false);
            let name = std::path::Path::new(project)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(project);
            let label = gtk::Label::new(Some(name));
            label.set_xalign(0.0);
            label.set_ellipsize(pango::EllipsizeMode::Start);
            label.style_context().add_class("agent-catalog-project");
            let line = gtk::Box::new(gtk::Orientation::Horizontal, 6);
            line.style_context().add_class("agent-catalog-project");
            line.pack_start(&icons::widget(Icon::Folder, 14), false, false, 0);
            line.pack_start(&label, true, true, 0);
            heading.add(&line);
            self.list.add(&heading);
            for index in items {
                let entry = &entries[index];
                let row = gtk::ListBoxRow::new();
                row.set_widget_name(&format!("thread-{index}"));
                row.style_context().add_class("agent-catalog-session");
                let line = gtk::Box::new(gtk::Orientation::Horizontal, 6);
                let title = gtk::Label::new(Some(&entry.title));
                title.set_xalign(0.0);
                title.set_ellipsize(pango::EllipsizeMode::End);
                line.pack_start(&title, true, true, 0);
                let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
                dot.set_valign(gtk::Align::Center);
                dot.style_context().add_class("session-dot");
                line.pack_end(&dot, false, false, 0);
                row.add(&line);
                self.list.add(&row);
                let row = SessionRow { widget: row, dot };
                row.update(entry, current.as_ref());
                rows[index] = Some(row);
            }
        }
        self.list.show_all();
    }
}

impl SessionRow {
    fn update(&self, entry: &Entry, current: Option<&(String, ThreadState)>) {
        let active = current.filter(|(id, _)| id == &entry.id);
        let row = self.widget.style_context();
        if active.is_some() {
            row.add_class("current-session");
        } else {
            row.remove_class("current-session");
        }
        let (class, name) = active.map_or(entry.state, |(_, state)| *state).appearance();
        let style = self.dot.style_context();
        for old in [
            "dot-idle",
            "dot-ready",
            "dot-running",
            "dot-waiting",
            "dot-error",
        ] {
            style.remove_class(old);
        }
        style.add_class(class);
        if let Some(accessible) = self.dot.accessible() {
            accessible.set_name(name);
        }
    }
}

pub fn wire_params(search: &glib::GString, archived: bool, cursor: Option<String>) -> Value {
    let search = search.trim();
    serde_json::json!({
        "limit": 30, "sortKey": "updated_at", "archived": archived,
        "cursor": cursor, "searchTerm": (!search.is_empty()).then_some(search)
    })
}
