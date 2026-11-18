use crate::files::{self, Directory, Kind, Source};
use crate::icons::{self, Icon};
use crate::session::Session;
use gtk::prelude::*;
use gtk::{gio, glib, pango};
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};

pub struct Browser {
    pub panel: gtk::Box,
    path: gtk::Entry,
    status: gtk::Label,
    parent: gtk::Button,
    refresh: gtk::Button,
    hidden: gtk::ToggleButton,
    list: gtk::ListStore,
    rows: gtk::TreeView,
    session: RefCell<Weak<Session>>,
    directory: RefCell<Option<Directory>>,
    request: Cell<u64>,
    pending: RefCell<Option<Request>>,
    in_flight: Cell<bool>,
    loading: Cell<bool>,
    monitor: RefCell<Option<gio::FileMonitor>>,
}

struct Request {
    id: u64,
    source: Source,
    path: Option<PathBuf>,
}

impl Browser {
    pub fn new() -> Rc<Self> {
        let panel = gtk::Box::new(gtk::Orientation::Vertical, 0);
        panel.style_context().add_class("files-panel");
        panel.set_width_request(330);

        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        header.style_context().add_class("files-header");
        header.pack_start(&icons::widget(Icon::Folder, 17), false, false, 0);
        let title = gtk::Label::builder().label("文件目录").xalign(0.0).build();
        title.style_context().add_class("section-title");
        header.pack_start(&title, true, true, 0);

        let hidden = gtk::ToggleButton::with_label("隐藏项");
        hidden.set_tooltip_text(Some("显示隐藏文件和目录"));
        header.pack_start(&hidden, false, false, 0);
        let close = tool(Icon::Close, "收起文件目录");
        close.set_action_name(Some("win.files"));
        header.pack_start(&close, false, false, 0);
        panel.pack_start(&header, false, false, 0);

        let location = gtk::Box::new(gtk::Orientation::Horizontal, 5);
        location.style_context().add_class("files-location");
        let parent = tool(Icon::Up, "上一级目录");
        location.pack_start(&parent, false, false, 0);
        let path = gtk::Entry::builder()
            .placeholder_text("目录路径")
            .width_chars(12)
            .build();
        location.pack_start(&path, true, true, 0);
        let refresh = tool(Icon::Refresh, "刷新目录");
        location.pack_start(&refresh, false, false, 0);
        panel.pack_start(&location, false, false, 0);

        let list = gtk::ListStore::new(&[
            String::static_type(),
            String::static_type(),
            String::static_type(),
            String::static_type(),
            u32::static_type(),
        ]);
        let rows = gtk::TreeView::with_model(&list);
        rows.style_context().add_class("files-table");
        rows.set_headers_visible(true);
        rows.set_enable_search(true);
        rows.set_search_column(0);
        rows.set_tooltip_column(0);
        for (index, (title, width)) in
            [("名称", 144), ("大小", 61), ("修改时间", 111), ("权限", 76)]
                .into_iter()
                .enumerate()
        {
            let renderer = gtk::CellRendererText::new();
            renderer.set_ellipsize(pango::EllipsizeMode::End);
            let column = gtk::TreeViewColumn::new();
            column.set_title(title);
            column.set_resizable(true);
            column.set_expand(index == 0);
            column.set_sizing(gtk::TreeViewColumnSizing::Fixed);
            column.set_fixed_width(width);
            TreeViewColumnExt::pack_start(&column, &renderer, true);
            TreeViewColumnExt::add_attribute(&column, &renderer, "text", index as i32);
            rows.append_column(&column);
        }

        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Automatic)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .build();
        scroll.add(&rows);
        panel.pack_start(&scroll, true, true, 0);

        let status = gtk::Label::builder()
            .label("打开终端标签以浏览文件")
            .xalign(0.0)
            .ellipsize(pango::EllipsizeMode::End)
            .build();
        status.style_context().add_class("files-status");
        panel.pack_end(&status, false, false, 0);

        panel.show_all();
        panel.set_no_show_all(true);
        panel.hide();
        let browser = Rc::new(Self {
            panel,
            path,
            status,
            parent,
            refresh,
            hidden,
            list,
            rows,
            session: RefCell::new(Weak::new()),
            directory: RefCell::new(None),
            request: Cell::new(0),
            pending: RefCell::new(None),
            in_flight: Cell::new(false),
            loading: Cell::new(false),
            monitor: RefCell::new(None),
        });
        browser.connect();
        browser.update_controls();
        browser
    }

    pub fn select(self: &Rc<Self>, session: Option<&Rc<Session>>) {
        let next = session.map(Rc::downgrade).unwrap_or_default();
        if !self.panel.is_visible() || self.session.borrow().ptr_eq(&next) {
            return;
        }
        self.session.replace(next);
        self.invalidate();
        self.directory.replace(None);
        self.list.clear();
        self.path.set_text("");
        if let Some(session) = session {
            self.load(session.directory.borrow().clone());
        } else {
            self.status.set_text("打开终端标签以浏览文件");
            self.update_controls();
        }
    }

    pub fn reset(&self) {
        self.invalidate();
        self.session.replace(Weak::new());
        self.directory.replace(None);
        self.list.clear();
        self.path.set_text("");
        self.status.set_text("打开终端标签以浏览文件");
        self.update_controls();
    }

    fn invalidate(&self) {
        self.request.set(self.request.get() + 1);
        self.pending.take();
        self.loading.set(false);
        if let Some(monitor) = self.monitor.take() {
            monitor.cancel();
        }
    }

    fn connect(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        self.path.connect_activate(move |entry| {
            if let Some(browser) = weak.upgrade() {
                let text = entry.text();
                let current = browser.current_path();
                let path = match (text.as_str(), current) {
                    ("", _) => None,
                    (text, Some(current)) if text == files::display(current.as_os_str()) => {
                        Some(current)
                    }
                    (text, Some(current)) => Some(current.join(text)),
                    (text, None) => Some(PathBuf::from(text)),
                };
                browser.load(path);
            }
        });
        let weak = Rc::downgrade(self);
        self.parent.connect_clicked(move |_| {
            if let Some(browser) = weak.upgrade() {
                if let Some(path) = browser
                    .current_path()
                    .and_then(|path| path.parent().map(Path::to_path_buf))
                {
                    browser.load(Some(path));
                }
            }
        });
        let weak = Rc::downgrade(self);
        self.refresh.connect_clicked(move |_| {
            if let Some(browser) = weak.upgrade() {
                browser.load(browser.current_path());
            }
        });
        let weak = Rc::downgrade(self);
        self.hidden.connect_toggled(move |_| {
            if let Some(browser) = weak.upgrade() {
                browser.render();
            }
        });
        let weak = Rc::downgrade(self);
        self.rows.connect_row_activated(move |_, path, _| {
            if let Some(browser) = weak.upgrade() {
                if let Some(path) = browser.activated_directory(path) {
                    browser.load(Some(path));
                }
            }
        });
    }

    fn current_path(&self) -> Option<PathBuf> {
        self.directory
            .borrow()
            .as_ref()
            .map(|entry| entry.path.clone())
            .or_else(|| self.session.borrow().upgrade()?.directory.borrow().clone())
    }

    fn activated_directory(&self, row: &gtk::TreePath) -> Option<PathBuf> {
        let iter = self.list.iter(row)?;
        let index = self.list.value(&iter, 4).get::<u32>().ok()? as usize;
        let directory = self.directory.borrow();
        let directory = directory.as_ref()?;
        let entry = directory.entries.get(index)?;
        matches!(entry.kind, Kind::Directory | Kind::Symlink | Kind::Other)
            .then(|| directory.path.join(&entry.name))
    }

    fn load(self: &Rc<Self>, path: Option<PathBuf>) {
        let Some(session) = self.session.borrow().upgrade() else {
            return;
        };
        self.invalidate();
        let id = self.request.get();
        let source = session.file_source();
        self.status.set_tooltip_text(None);
        if let Source::Sftp {
            socket: Some(socket),
        } = &source
        {
            if !crate::sftp::socket_ready(socket) && self.watch_socket(id, socket, path.clone()) {
                self.status.set_text("等待 SSH 登录…");
                self.update_controls();
                return;
            }
        }
        self.loading.set(true);
        self.status.set_text("正在读取目录…");
        self.update_controls();
        self.pending.replace(Some(Request { id, source, path }));
        self.start_pending();
    }

    pub fn reload(self: &Rc<Self>) {
        if self.panel.is_visible() {
            self.load(self.current_path());
        }
    }

    fn watch_socket(self: &Rc<Self>, id: u64, socket: &Path, path: Option<PathBuf>) -> bool {
        let Some(directory) = socket.parent() else {
            return false;
        };
        let Ok(monitor) = gio::File::for_path(directory)
            .monitor_directory(gio::FileMonitorFlags::NONE, gio::Cancellable::NONE)
        else {
            return false;
        };
        if crate::sftp::socket_ready(socket) {
            monitor.cancel();
            return false;
        }
        let weak = Rc::downgrade(self);
        let socket = socket.to_path_buf();
        monitor.connect_changed(move |_, _, _, _| {
            if let Some(browser) = weak.upgrade() {
                if browser.request.get() == id && crate::sftp::socket_ready(&socket) {
                    browser.load(path.clone());
                }
            }
        });
        self.monitor.replace(Some(monitor));
        true
    }

    fn start_pending(self: &Rc<Self>) {
        if self.in_flight.get() {
            return;
        }
        let Some(Request { id, source, path }) = self.pending.take() else {
            return;
        };
        self.in_flight.set(true);
        let weak = Rc::downgrade(self);
        glib::MainContext::default().spawn_local(async move {
            let result = gio::spawn_blocking(move || source.list(path.as_deref()))
                .await
                .unwrap_or_else(|_| Err("目录读取意外中断。".into()));
            if let Some(browser) = weak.upgrade() {
                browser.in_flight.set(false);
                if browser.request.get() == id {
                    browser.loading.set(false);
                    browser.finish(result);
                }
                browser.start_pending();
            }
        });
    }

    fn finish(&self, result: Result<Directory, String>) {
        match result {
            Ok(directory) => {
                if let Some(session) = self.session.borrow().upgrade() {
                    session.directory.replace(Some(directory.path.clone()));
                }
                self.path
                    .set_text(&files::display(directory.path.as_os_str()));
                self.directory.replace(Some(directory));
                self.render();
            }
            Err(error) => {
                self.status.set_text(&error);
                self.status.set_tooltip_text(Some(&error));
            }
        }
        self.update_controls();
    }

    fn render(&self) {
        self.list.clear();
        if let Some(directory) = self.directory.borrow().as_ref() {
            let show_hidden = self.hidden.is_active();
            let mut shown = 0;
            for (index, entry) in directory.entries.iter().enumerate() {
                if !show_hidden && entry.hidden() {
                    continue;
                }
                shown += 1;
                let prefix = match entry.kind {
                    Kind::Directory => "▸  ",
                    Kind::Symlink => "↗  ",
                    _ => "    ",
                };
                let name = format!("{prefix}{}", files::display(&entry.name));
                let size = match (entry.kind, entry.size) {
                    (Kind::File, Some(size)) => glib::format_size(size).to_string(),
                    _ => "—".into(),
                };
                let modified = entry
                    .modified
                    .and_then(|timestamp| glib::DateTime::from_unix_local(timestamp).ok())
                    .and_then(|date| date.format("%Y-%m-%d %H:%M").ok())
                    .map_or_else(|| "—".into(), |s| s.to_string());
                let mode = entry
                    .mode
                    .map_or_else(|| "—".into(), |mode| format!("{:04o}", mode & 0o7777));
                self.list.insert_with_values(
                    None,
                    &[
                        (0, &name),
                        (1, &size),
                        (2, &modified),
                        (3, &mode),
                        (4, &(index as u32)),
                    ],
                );
            }
            if !self.loading.get() {
                self.status.set_tooltip_text(None);
                let suffix = if directory.truncated {
                    " · 到达显示上限"
                } else {
                    ""
                };
                self.status.set_text(&format!("{shown} 项{suffix}"));
            }
        }
    }

    fn update_controls(&self) {
        let available = self.session.borrow().strong_count() > 0 && !self.loading.get();
        let has_parent = self
            .current_path()
            .is_some_and(|path| path.parent().is_some());
        self.path.set_sensitive(available);
        self.parent.set_sensitive(available && has_parent);
        self.refresh.set_sensitive(available);
        self.rows.set_sensitive(available);
        self.hidden.set_sensitive(available);
    }
}

fn tool(icon: Icon, tooltip: &str) -> gtk::Button {
    let button = gtk::Button::builder().tooltip_text(tooltip).build();
    button.style_context().add_class("quiet-button");
    button.add(&icons::widget(icon, 16));
    button
}
