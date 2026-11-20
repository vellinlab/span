use crate::files::{self, Directory, Kind, Source};
use crate::icons::{self, Icon};
use crate::preview::{Artifact, Panel};
use crate::session::Session;
use gtk::prelude::*;
use gtk::{gdk, gdk_pixbuf, gio, glib, pango};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};

const DIRECTORY_FRESHNESS: Duration = Duration::from_secs(15);
const CACHED_DIRECTORIES: usize = 3;
const PATH_COMPLETION_DELAY: Duration = Duration::from_millis(150);
const MAX_PATH_MATCHES: usize = 12;
const CACHED_COMPLETIONS: usize = 2;

pub struct Browser {
    pub panel: gtk::Box,
    path: gtk::Entry,
    path_popup: gtk::Popover,
    path_matches: gtk::ListBox,
    path_targets: RefCell<Vec<PathBuf>>,
    setting_path: Cell<bool>,
    completion_requested: Cell<bool>,
    completion_timer: RefCell<Option<glib::SourceId>>,
    completion_cache: RefCell<VecDeque<CompletionCache>>,
    completing: Cell<bool>,
    status: gtk::Label,
    parent: gtk::Button,
    refresh: gtk::Button,
    upload: gtk::Button,
    download: gtk::Button,
    preview_button: gtk::Button,
    hidden: gtk::ToggleButton,
    entry_icons: [Option<gdk_pixbuf::Pixbuf>; 3],
    rows: gtk::TreeView,
    preview: Rc<Panel>,
    transfer_notice: gtk::Label,
    transferring: Cell<bool>,
    session: RefCell<Weak<Session>>,
    directory: RefCell<Option<Rc<Directory>>>,
    cached: RefCell<VecDeque<DirectoryView>>,
    request: Cell<u64>,
    pending: RefCell<Option<Request>>,
    in_flight: Cell<bool>,
    loading: Cell<bool>,
    monitor: RefCell<Option<gio::FileMonitor>>,
}

struct DirectoryView {
    session: Weak<Session>,
    source: Source,
    directory: Rc<Directory>,
    model: gtk::ListStore,
    fetched_at: Instant,
    show_hidden: bool,
}

struct Request {
    id: u64,
    source: Source,
    path: Option<PathBuf>,
}

struct CompletionCache {
    parent: Option<PathBuf>,
    directory: Option<Rc<Directory>>,
    fetched_at: Instant,
}

impl Browser {
    pub fn new(preview: Rc<Panel>) -> Rc<Self> {
        let panel = gtk::Box::new(gtk::Orientation::Vertical, 0);
        panel.style_context().add_class("files-panel");

        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        header.style_context().add_class("files-header");
        header.pack_start(&icons::widget(Icon::Folder, 17), false, false, 0);
        let title = gtk::Label::builder().label("文件目录").xalign(0.0).build();
        title.style_context().add_class("section-title");
        header.pack_start(&title, true, true, 0);

        let hidden = gtk::ToggleButton::new();
        hidden.style_context().add_class("quiet-button");
        hidden.set_tooltip_text(Some("显示隐藏文件和目录"));
        if let Some(accessible) = hidden.accessible() {
            accessible.set_name("显示隐藏项");
        }
        let toggle = hidden.downgrade();
        let eye = icons::changing_widget(18, move || {
            if toggle.upgrade().is_some_and(|button| button.is_active()) {
                Icon::Eye
            } else {
                Icon::EyeOff
            }
        });
        hidden.add(&eye);
        hidden.connect_toggled(move |button| {
            button.set_tooltip_text(Some(if button.is_active() {
                "隐藏文件和目录"
            } else {
                "显示隐藏文件和目录"
            }));
            eye.queue_draw();
        });
        header.pack_start(&hidden, false, false, 0);
        panel.pack_start(&header, false, false, 0);

        let location = gtk::Box::new(gtk::Orientation::Horizontal, 5);
        location.style_context().add_class("files-location");
        let parent = tool(Icon::Up, "上一级目录");
        location.pack_start(&parent, false, false, 0);
        let path = gtk::Entry::builder()
            .placeholder_text("目录路径")
            .width_chars(12)
            .max_width_chars(16)
            .build();
        if let Some(accessible) = path.accessible() {
            accessible.set_name("目录路径");
        }
        location.pack_start(&path, true, true, 0);
        let path_popup = gtk::Popover::new(Some(&path));
        path_popup.set_position(gtk::PositionType::Bottom);
        path_popup.set_modal(false);
        path_popup.set_no_show_all(true);
        path_popup.style_context().add_class("files-path-popup");
        if let Some(accessible) = path_popup.accessible() {
            accessible.set_name("目录建议");
        }
        let path_matches = gtk::ListBox::new();
        path_matches.set_activate_on_single_click(true);
        path_matches.set_can_focus(false);
        path_matches.show();
        path_popup.add(&path_matches);
        let refresh = tool(Icon::Refresh, "刷新目录");
        location.pack_start(&refresh, false, false, 0);
        panel.pack_start(&location, false, false, 0);

        let actions = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        actions.style_context().add_class("files-actions");
        let upload = labeled_tool(Icon::Upload, "上传");
        let download = labeled_tool(Icon::Download, "下载");
        let preview_button = labeled_tool(Icon::File, "预览");
        for button in [&upload, &download, &preview_button] {
            actions.pack_start(button, false, false, 0);
        }
        panel.pack_start(&actions, false, false, 0);

        let rows = gtk::TreeView::new();
        rows.style_context().add_class("files-table");
        rows.set_headers_visible(true);
        rows.set_enable_search(true);
        rows.set_search_column(0);
        rows.set_tooltip_column(4);
        for (index, (title, width)) in [("名称", 118), ("大小", 68)].into_iter().enumerate() {
            let renderer = gtk::CellRendererText::new();
            renderer.set_ellipsize(pango::EllipsizeMode::End);
            let column = gtk::TreeViewColumn::new();
            column.set_title(title);
            column.set_resizable(true);
            column.set_expand(index == 0);
            column.set_sizing(gtk::TreeViewColumnSizing::Fixed);
            column.set_fixed_width(width);
            if index == 0 {
                let image = gtk::CellRendererPixbuf::new();
                image.set_padding(5, 0);
                TreeViewColumnExt::pack_start(&column, &image, false);
                TreeViewColumnExt::add_attribute(&column, &image, "pixbuf", 3);
            }
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

        let transfer_notice = gtk::Label::builder()
            .xalign(0.0)
            .ellipsize(pango::EllipsizeMode::End)
            .build();
        transfer_notice.style_context().add_class("files-transfer");
        transfer_notice.set_no_show_all(true);
        panel.pack_start(&transfer_notice, false, false, 0);

        let status = gtk::Label::builder()
            .label("打开终端标签以浏览文件")
            .xalign(0.0)
            .ellipsize(pango::EllipsizeMode::End)
            .build();
        status.style_context().add_class("files-status");
        panel.pack_end(&status, false, false, 0);

        panel.show_all();
        let browser = Rc::new(Self {
            panel,
            path,
            path_popup,
            path_matches,
            path_targets: RefCell::new(Vec::new()),
            setting_path: Cell::new(false),
            completion_requested: Cell::new(false),
            completion_timer: RefCell::new(None),
            completion_cache: RefCell::new(VecDeque::new()),
            completing: Cell::new(false),
            status,
            parent,
            refresh,
            upload,
            download,
            preview_button,
            hidden,
            entry_icons: [
                icons::pixbuf(Icon::Folder, 16, &gdk::RGBA::new(0.60, 0.76, 0.97, 1.0)),
                icons::pixbuf(Icon::File, 16, &gdk::RGBA::new(0.63, 0.68, 0.74, 1.0)),
                icons::pixbuf(Icon::Link, 16, &gdk::RGBA::new(0.63, 0.68, 0.74, 1.0)),
            ],
            rows,
            preview,
            transfer_notice,
            transferring: Cell::new(false),
            session: RefCell::new(Weak::new()),
            directory: RefCell::new(None),
            cached: RefCell::new(VecDeque::new()),
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
        if self.session.borrow().ptr_eq(&next) {
            return;
        }
        self.session.replace(next.clone());
        self.invalidate();
        let current = session.and_then(|session| self.take_cached(&next, &session.file_source()));
        if let Some(view) = current {
            let fresh = view.fetched_at.elapsed() < DIRECTORY_FRESHNESS;
            self.directory.replace(Some(view.directory.clone()));
            self.set_path(&files::display(view.directory.path.as_os_str()));
            if view.show_hidden == self.hidden.is_active() {
                self.show_model(&view.model, &view.directory);
            } else {
                self.render();
            }
            self.cache_view(view);
            if fresh {
                self.update_controls();
                return;
            }
        } else {
            self.clear_view();
        }
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
        self.cached.borrow_mut().clear();
        self.clear_view();
        self.status.set_text("打开终端标签以浏览文件");
        self.update_controls();
    }

    fn clear_view(&self) {
        self.directory.take();
        self.rows.set_model(gtk::TreeModel::NONE);
        self.set_path("");
    }

    fn take_cached(&self, session: &Weak<Session>, source: &Source) -> Option<DirectoryView> {
        let mut cached = self.cached.borrow_mut();
        cached.retain(|view| view.session.strong_count() > 0);
        if let Source::Sftp { socket } = source
            && !socket.as_deref().is_some_and(crate::sftp::channel_ready)
        {
            return None;
        }
        let index = cached
            .iter()
            .position(|view| view.session.ptr_eq(session) && view.source == *source)?;
        cached.remove(index)
    }

    fn cache_view(&self, view: DirectoryView) {
        let mut cached = self.cached.borrow_mut();
        cached.retain(|item| !item.session.ptr_eq(&view.session));
        cached.push_front(view);
        cached.truncate(CACHED_DIRECTORIES);
    }

    fn invalidate(&self) {
        self.clear_path_matches();
        self.completion_cache.borrow_mut().clear();
        self.request.set(self.request.get() + 1);
        self.pending.take();
        self.loading.set(false);
        if let Some(monitor) = self.monitor.take() {
            monitor.cancel();
        }
    }

    fn connect(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        self.path.connect_changed(move |_| {
            if let Some(browser) = weak.upgrade() {
                browser.queue_path_completion();
            }
        });
        let weak = Rc::downgrade(self);
        self.path_matches.connect_row_activated(move |_, row| {
            if let Some(browser) = weak.upgrade() {
                browser.open_path_match(row);
            }
        });
        let weak = Rc::downgrade(self);
        self.path.connect_key_press_event(move |_, event| {
            if let Some(browser) = weak.upgrade() {
                return browser.path_key(event);
            }
            glib::Propagation::Proceed
        });
        let weak = Rc::downgrade(self);
        self.path.connect_focus_out_event(move |_, _| {
            if let Some(browser) = weak.upgrade() {
                browser.clear_path_matches();
            }
            glib::Propagation::Proceed
        });
        let weak = Rc::downgrade(self);
        self.path.connect_unmap(move |_| {
            if let Some(browser) = weak.upgrade() {
                browser.clear_path_matches();
            }
        });
        let weak = Rc::downgrade(self);
        self.path.connect_activate(move |entry| {
            if let Some(browser) = weak.upgrade() {
                if browser.path_popup.is_visible()
                    && let Some(row) = browser.path_matches.selected_row()
                {
                    browser.open_path_match(&row);
                    return;
                }
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
                if let Some((path, kind)) = browser.entry_at(path) {
                    if kind == Kind::File {
                        browser.open_preview(path);
                    } else {
                        browser.load(Some(path));
                    }
                }
            }
        });
        let weak = Rc::downgrade(self);
        self.rows.selection().connect_changed(move |_| {
            if let Some(browser) = weak.upgrade() {
                browser.update_controls();
            }
        });
        let weak = Rc::downgrade(self);
        self.preview_button.connect_clicked(move |_| {
            if let Some(browser) = weak.upgrade()
                && let Some(path) = browser.selected_file()
            {
                browser.open_preview(path);
            }
        });
        let weak = Rc::downgrade(self);
        self.upload.connect_clicked(move |button| {
            if let Some(browser) = weak.upgrade() {
                browser.choose_transfer(button, true);
            }
        });
        let weak = Rc::downgrade(self);
        self.download.connect_clicked(move |button| {
            if let Some(browser) = weak.upgrade() {
                browser.choose_transfer(button, false);
            }
        });
    }

    fn clear_path_matches(&self) {
        self.completion_requested.set(false);
        if let Some(timer) = self.completion_timer.take() {
            timer.remove();
        }
        self.path_popup.hide();
    }

    fn set_path(&self, text: &str) {
        self.setting_path.set(true);
        self.path.set_text(text);
        self.setting_path.set(false);
    }

    fn open_path_match(self: &Rc<Self>, row: &gtk::ListBoxRow) {
        let path = self
            .path_targets
            .borrow()
            .get(row.index() as usize)
            .cloned();
        if let Some(path) = path {
            self.load(Some(path));
        }
    }

    fn path_key(&self, event: &gdk::EventKey) -> glib::Propagation {
        if event.keyval() == gdk::keys::constants::Escape && self.completion_requested.get() {
            self.clear_path_matches();
            return glib::Propagation::Stop;
        }
        if !self.path_popup.is_visible()
            || event.state().intersects(
                gdk::ModifierType::SHIFT_MASK
                    | gdk::ModifierType::CONTROL_MASK
                    | gdk::ModifierType::MOD1_MASK,
            )
        {
            return glib::Propagation::Proceed;
        }
        let count = self.path_targets.borrow().len() as i32;
        let current = self.path_matches.selected_row().map(|row| row.index());
        let index = match event.keyval() {
            gdk::keys::constants::Down => (current.unwrap_or(-1) + 1).min(count - 1),
            gdk::keys::constants::Up => (current.unwrap_or(count) - 1).max(0),
            _ => return glib::Propagation::Proceed,
        };
        self.path_matches
            .select_row(self.path_matches.row_at_index(index).as_ref());
        glib::Propagation::Stop
    }

    fn queue_path_completion(self: &Rc<Self>) {
        self.clear_path_matches();
        if self.setting_path.get()
            || !self.path.has_focus()
            || !self.path.is_sensitive()
            || self.path.text().is_empty()
        {
            return;
        }
        self.completion_requested.set(true);
        let weak = Rc::downgrade(self);
        self.completion_timer
            .replace(Some(glib::timeout_add_local_once(
                PATH_COMPLETION_DELAY,
                move || {
                    if let Some(browser) = weak.upgrade() {
                        browser.completion_timer.take();
                        browser.complete_path();
                    }
                },
            )));
    }

    fn complete_path(self: &Rc<Self>) {
        if !self.completion_requested.get()
            || !self.path.has_focus()
            || !self.path.is_mapped()
            || !self.path.is_sensitive()
        {
            return;
        }
        let text = self.path.text();
        let current = self.current_path();
        let Some(session) = self.session.borrow().upgrade() else {
            return;
        };
        let source = session.file_source();
        let case_insensitive = cfg!(windows) && source == Source::Local;
        if let Some(current) = current.as_ref()
            && text == files::display(current.as_os_str())
            && let Some(directory) = self.directory.borrow().as_ref()
        {
            self.show_path_matches(directory, "", case_insensitive);
            return;
        }
        let split = text
            .rfind(|c| c == '/' || (case_insensitive && c == '\\'))
            .map_or(0, |i| i + 1);
        let (prefix, name) = text.split_at(split);
        let parent = match (prefix, current) {
            ("", current) => current,
            (prefix, current) => Some(current.unwrap_or_default().join(prefix)),
        };
        let Some(Some(directory)) = self.completion_directory(&source, parent) else {
            return;
        };
        if name.is_empty() {
            self.show_path_matches(&directory, "", case_insensitive);
            return;
        }
        let exact_name = if case_insensitive {
            name.to_lowercase()
        } else {
            name.to_owned()
        };
        let exact = directory.entries.iter().find(|entry| {
            if !matches!(entry.kind, Kind::Directory | Kind::Symlink) {
                return false;
            }
            let label = files::display(&entry.name);
            if case_insensitive {
                label.to_lowercase() == exact_name
            } else {
                label == exact_name
            }
        });
        if let Some(entry) = exact {
            match self.completion_directory(&source, Some(directory.path.join(&entry.name))) {
                Some(Some(children)) => {
                    self.show_path_matches(&children, "", case_insensitive);
                }
                Some(None) => self.show_path_matches(&directory, name, case_insensitive),
                None => {}
            }
        } else {
            self.show_path_matches(&directory, name, case_insensitive);
        }
    }

    // The outer option distinguishes an in-flight lookup from an unreadable directory.
    fn completion_directory(
        self: &Rc<Self>,
        source: &Source,
        parent: Option<PathBuf>,
    ) -> Option<Option<Rc<Directory>>> {
        if let Some(directory) = self.directory.borrow().as_ref()
            && Some(directory.path.as_path()) == parent.as_deref()
        {
            return Some(Some(directory.clone()));
        }
        if let Some(cache) = self.completion_cache.borrow().iter().find(|cache| {
            cache.parent == parent && cache.fetched_at.elapsed() < DIRECTORY_FRESHNESS
        }) {
            return Some(cache.directory.clone());
        }
        if self.completing.replace(true) {
            return None;
        }
        let weak = Rc::downgrade(self);
        let request = self.request.get();
        let source = source.clone();
        glib::MainContext::default().spawn_local(async move {
            let lookup = parent.clone();
            let directory = gio::spawn_blocking(move || source.list(lookup.as_deref()).ok())
                .await
                .ok()
                .flatten();
            if let Some(browser) = weak.upgrade() {
                browser.completing.set(false);
                if browser.request.get() == request {
                    let mut cache = browser.completion_cache.borrow_mut();
                    cache.retain(|result| result.parent != parent);
                    cache.push_front(CompletionCache {
                        parent,
                        directory: directory.map(Rc::new),
                        fetched_at: Instant::now(),
                    });
                    cache.truncate(CACHED_COMPLETIONS);
                }
                if browser.completion_timer.borrow().is_none() {
                    browser.complete_path();
                }
            }
        });
        None
    }

    fn show_path_matches(&self, directory: &Directory, prefix: &str, case_insensitive: bool) {
        for row in self.path_matches.children() {
            self.path_matches.remove(&row);
        }
        let mut targets = self.path_targets.borrow_mut();
        targets.clear();
        let show_hidden = self.hidden.is_active() || prefix.starts_with('.');
        let prefix = if case_insensitive {
            prefix.to_lowercase()
        } else {
            prefix.to_owned()
        };
        let matches = directory.entries.iter().filter_map(|entry| {
            if entry.kind != Kind::Directory || (!show_hidden && entry.hidden()) {
                return None;
            }
            let name = files::display(&entry.name);
            let matches = if case_insensitive {
                name.to_lowercase().starts_with(&prefix)
            } else {
                name.starts_with(&prefix)
            };
            matches.then_some((name, &entry.name))
        });
        for (label, name) in matches.take(MAX_PATH_MATCHES) {
            let row = gtk::ListBoxRow::new();
            row.set_can_focus(false);
            let content = gtk::Box::new(gtk::Orientation::Horizontal, 8);
            content.add(&icons::widget(Icon::Folder, 15));
            let title = gtk::Label::builder()
                .label(&label)
                .xalign(0.0)
                .ellipsize(pango::EllipsizeMode::End)
                .build();
            content.pack_start(&title, true, true, 0);
            row.add(&content);
            self.path_matches.add(&row);
            row.show_all();
            targets.push(directory.path.join(name));
        }
        self.path_matches.unselect_all();
        if !targets.is_empty() {
            self.path_matches
                .set_width_request(self.path.allocated_width().max(150));
            self.path_popup.show();
        }
    }

    fn current_path(&self) -> Option<PathBuf> {
        self.directory
            .borrow()
            .as_ref()
            .map(|entry| entry.path.clone())
            .or_else(|| self.session.borrow().upgrade()?.directory.borrow().clone())
    }

    fn entry_at(&self, row: &gtk::TreePath) -> Option<(PathBuf, Kind)> {
        let model = self.rows.model()?;
        let iter = model.iter(row)?;
        let index = model.value(&iter, 2).get::<u32>().ok()? as usize;
        let directory = self.directory.borrow();
        let directory = directory.as_ref()?;
        let entry = directory.entries.get(index)?;
        Some((directory.path.join(&entry.name), entry.kind))
    }

    fn selected_file(&self) -> Option<PathBuf> {
        let (model, iter) = self.rows.selection().selected()?;
        let (path, kind) = self.entry_at(&model.path(&iter)?)?;
        (kind == Kind::File).then_some(path)
    }

    fn open_preview(&self, path: PathBuf) {
        if let Some(session) = self.session.borrow().upgrade() {
            let source = session.file_source();
            self.preview
                .offer(&session, Artifact::File { source, path }, false);
        }
    }

    fn choose_transfer(self: &Rc<Self>, button: &gtk::Button, upload: bool) {
        let Some(session) = self.session.borrow().upgrade() else {
            return;
        };
        let target = if upload {
            self.current_path()
        } else {
            self.selected_file()
        };
        let Some(target) = target else { return };
        let source = session.file_source();
        let session = Rc::downgrade(&session);
        let parent = button.toplevel().and_downcast::<gtk::Window>();
        let (title, action, accept) = if upload {
            ("上传文件", gtk::FileChooserAction::Open, "上传")
        } else {
            ("下载文件", gtk::FileChooserAction::Save, "保存")
        };
        let dialog = gtk::FileChooserDialog::new(Some(title), parent.as_ref(), action);
        dialog.set_modal(true);
        dialog.set_destroy_with_parent(true);
        dialog.add_buttons(&[
            ("取消", gtk::ResponseType::Cancel),
            (accept, gtk::ResponseType::Accept),
        ]);
        dialog.set_default_response(gtk::ResponseType::Accept);
        if !upload {
            dialog.set_current_name(&file_name(&target));
            dialog.set_do_overwrite_confirmation(true);
        }
        let weak = Rc::downgrade(self);
        dialog.connect_response(move |dialog, response| {
            if response == gtk::ResponseType::Accept
                && let (Some(browser), Some(local)) = (weak.upgrade(), dialog.filename())
            {
                browser.transfer(
                    source.clone(),
                    session.clone(),
                    target.clone(),
                    local,
                    upload,
                );
            }
            dialog.close();
        });
        dialog.show();
    }

    fn transfer(
        self: &Rc<Self>,
        source: Source,
        session: Weak<Session>,
        target: PathBuf,
        local: PathBuf,
        upload: bool,
    ) {
        if self.transferring.replace(true) {
            return;
        }
        let name = file_name(if upload { &local } else { &target });
        self.show_transfer_notice(&format!(
            "正在{} · {name}",
            if upload { "上传" } else { "下载" }
        ));
        self.update_controls();
        let weak = Rc::downgrade(self);
        let work_dir = target.clone();
        glib::MainContext::default().spawn_local(async move {
            let result = gio::spawn_blocking(move || {
                if upload {
                    let name = local.file_name().ok_or("无法识别上传文件名。")?;
                    source.upload(&local, &target.join(name))
                } else {
                    source.download(&target, &local)
                }
            })
            .await
            .unwrap_or_else(|_| Err("文件传输被中断。".into()));
            if let Some(browser) = weak.upgrade() {
                browser.transferring.set(false);
                match result {
                    Ok(()) => {
                        browser.show_transfer_notice(&format!(
                            "{} · {name}",
                            if upload { "已上传" } else { "已下载" }
                        ));
                        if upload {
                            browser
                                .cached
                                .borrow_mut()
                                .retain(|view| !view.session.ptr_eq(&session));
                            if browser.panel.is_mapped()
                                && browser.session.borrow().ptr_eq(&session)
                                && browser.current_path().as_ref() == Some(&work_dir)
                            {
                                browser.load(Some(work_dir));
                            }
                        }
                    }
                    Err(error) => browser.show_transfer_notice(&error),
                }
                browser.update_controls();
            }
        });
    }

    fn show_transfer_notice(&self, text: &str) {
        self.transfer_notice.set_text(text);
        self.transfer_notice.set_tooltip_text(Some(text));
        self.transfer_notice.show();
    }

    fn load(self: &Rc<Self>, path: Option<PathBuf>) {
        let Some(session) = self.session.borrow().upgrade() else {
            return;
        };
        self.invalidate();
        let id = self.request.get();
        let source = session.file_source();
        self.status.set_tooltip_text(None);
        #[cfg(unix)]
        if let Source::Sftp {
            socket: Some(socket),
        } = &source
        {
            if !crate::sftp::channel_ready(socket) && self.watch_socket(id, socket, path.clone()) {
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
        if self.panel.is_mapped() {
            let session = self.session.borrow();
            self.cached
                .borrow_mut()
                .retain(|view| !view.session.ptr_eq(&session));
            self.load(self.current_path());
        }
    }

    #[cfg(unix)]
    fn watch_socket(self: &Rc<Self>, id: u64, socket: &Path, path: Option<PathBuf>) -> bool {
        let Some(directory) = socket.parent() else {
            return false;
        };
        let Ok(monitor) = gio::File::for_path(directory)
            .monitor_directory(gio::FileMonitorFlags::NONE, gio::Cancellable::NONE)
        else {
            return false;
        };
        if crate::sftp::channel_ready(socket) {
            monitor.cancel();
            return false;
        }
        let weak = Rc::downgrade(self);
        let socket = socket.to_path_buf();
        monitor.connect_changed(move |_, _, _, _| {
            if let Some(browser) = weak.upgrade() {
                if browser.request.get() == id && crate::sftp::channel_ready(&socket) {
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
            let reader = source.clone();
            let result = gio::spawn_blocking(move || reader.list(path.as_deref()))
                .await
                .unwrap_or_else(|_| Err("目录读取意外中断。".into()));
            if let Some(browser) = weak.upgrade() {
                browser.in_flight.set(false);
                if browser.request.get() == id {
                    browser.loading.set(false);
                    browser.finish(source, result);
                }
                browser.start_pending();
            }
        });
    }

    fn finish(&self, source: Source, result: Result<Directory, String>) {
        match result {
            Ok(directory) => {
                if let Some(session) = self.session.borrow().upgrade() {
                    session.directory.replace(Some(directory.path.clone()));
                }
                self.set_path(&files::display(directory.path.as_os_str()));
                let directory = Rc::new(directory);
                self.directory.replace(Some(directory.clone()));
                let show_hidden = self.hidden.is_active();
                let model = self.build_model(&directory, show_hidden);
                self.show_model(&model, &directory);
                self.cache_view(DirectoryView {
                    session: self.session.borrow().clone(),
                    source,
                    directory,
                    model,
                    fetched_at: Instant::now(),
                    show_hidden,
                });
            }
            Err(error) => {
                self.status.set_text(&error);
                self.status.set_tooltip_text(Some(&error));
            }
        }
        self.update_controls();
    }

    fn render(&self) {
        if let Some(directory) = self.directory.borrow().as_ref() {
            let model = self.build_model(directory, self.hidden.is_active());
            self.show_model(&model, directory);
        }
    }

    fn build_model(&self, directory: &Directory, show_hidden: bool) -> gtk::ListStore {
        let list = gtk::ListStore::new(&[
            String::static_type(),
            String::static_type(),
            u32::static_type(),
            gdk_pixbuf::Pixbuf::static_type(),
            String::static_type(),
        ]);
        for (index, entry) in directory.entries.iter().enumerate() {
            if !show_hidden && entry.hidden() {
                continue;
            }
            let icon = match entry.kind {
                Kind::Directory => &self.entry_icons[0],
                Kind::Symlink => &self.entry_icons[2],
                _ => &self.entry_icons[1],
            };
            let name = files::display(&entry.name);
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
            list.insert_with_values(
                None,
                &[
                    (0, &name),
                    (1, &size),
                    (2, &(index as u32)),
                    (3, icon),
                    (
                        4,
                        &format!(
                            "{}\n修改时间 {modified} · 权限 {mode}",
                            glib::markup_escape_text(&name)
                        ),
                    ),
                ],
            );
        }
        list
    }

    fn show_model(&self, model: &gtk::ListStore, directory: &Directory) {
        self.rows.set_model(Some(model));
        if !self.loading.get() {
            self.status.set_tooltip_text(None);
            let suffix = if directory.truncated {
                " · 到达显示上限"
            } else {
                ""
            };
            self.status
                .set_text(&format!("{} 项{suffix}", model.iter_n_children(None)));
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
        let selected = available && self.selected_file().is_some();
        self.preview_button.set_sensitive(selected);
        self.download
            .set_sensitive(selected && !self.transferring.get());
        self.upload.set_sensitive(
            available && self.directory.borrow().is_some() && !self.transferring.get(),
        );
    }
}

fn file_name(path: &Path) -> String {
    files::display(path.file_name().unwrap_or_else(|| path.as_os_str()))
}

fn tool(icon: Icon, tooltip: &str) -> gtk::Button {
    let button = gtk::Button::builder().tooltip_text(tooltip).build();
    if let Some(accessible) = button.accessible() {
        accessible.set_name(tooltip);
    }
    button.style_context().add_class("quiet-button");
    button.add(&icons::widget(icon, 16));
    button
}

fn labeled_tool(icon: Icon, label: &str) -> gtk::Button {
    let button = gtk::Button::new();
    button.style_context().add_class("quiet-button");
    let line = gtk::Box::new(gtk::Orientation::Horizontal, 5);
    line.add(&icons::widget(icon, 15));
    line.add(&gtk::Label::new(Some(label)));
    button.add(&line);
    if let Some(accessible) = button.accessible() {
        accessible.set_name(label);
    }
    button
}
