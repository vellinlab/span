use crate::files::{self, Directory, Kind, Source};
use crate::icons::{self, Icon};
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

pub struct Browser {
    pub panel: gtk::Box,
    path: gtk::Entry,
    status: gtk::Label,
    parent: gtk::Button,
    refresh: gtk::Button,
    upload: gtk::Button,
    download: gtk::Button,
    preview_button: gtk::Button,
    hidden: gtk::ToggleButton,
    entry_icons: [Option<gdk_pixbuf::Pixbuf>; 3],
    rows: gtk::TreeView,
    content: gtk::Stack,
    preview_title: gtk::Label,
    preview_body: gtk::Box,
    preview_serial: Cell<u64>,
    preview_file: RefCell<Option<PathBuf>>,
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
            if index == 0 {
                let image = gtk::CellRendererPixbuf::new();
                image.set_padding(5, 0);
                TreeViewColumnExt::pack_start(&column, &image, false);
                TreeViewColumnExt::add_attribute(&column, &image, "pixbuf", 5);
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
        let content = gtk::Stack::builder().homogeneous(false).build();
        content.add_named(&scroll, "list");
        let preview = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let preview_header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        preview_header
            .style_context()
            .add_class("files-preview-header");
        let back = gtk::Button::with_label("返回目录");
        back.style_context().add_class("quiet-button");
        preview_header.pack_start(&back, false, false, 0);
        let preview_title = gtk::Label::builder()
            .xalign(0.0)
            .ellipsize(pango::EllipsizeMode::Middle)
            .build();
        preview_header.pack_start(&preview_title, true, true, 0);
        preview.pack_start(&preview_header, false, false, 0);
        let preview_body = gtk::Box::new(gtk::Orientation::Vertical, 0);
        preview_body.style_context().add_class("files-preview");
        preview.pack_start(&preview_body, true, true, 0);
        content.add_named(&preview, "preview");
        panel.pack_start(&content, true, true, 0);

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
        panel.set_no_show_all(true);
        panel.hide();
        let browser = Rc::new(Self {
            panel,
            path,
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
            content,
            preview_title,
            preview_body,
            preview_serial: Cell::new(0),
            preview_file: RefCell::new(None),
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
        let weak = Rc::downgrade(&browser);
        back.connect_clicked(move |_| {
            if let Some(browser) = weak.upgrade() {
                browser.close_preview();
            }
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
        self.session.replace(next.clone());
        self.invalidate();
        self.close_preview();
        let current = session.and_then(|session| self.take_cached(&next, &session.file_source()));
        if let Some(view) = current {
            let fresh = view.fetched_at.elapsed() < DIRECTORY_FRESHNESS;
            self.directory.replace(Some(view.directory.clone()));
            self.path
                .set_text(&files::display(view.directory.path.as_os_str()));
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
        self.close_preview();
        self.clear_view();
        self.status.set_text("打开终端标签以浏览文件");
        self.update_controls();
    }

    fn clear_view(&self) {
        self.directory.take();
        self.rows.set_model(gtk::TreeModel::NONE);
        self.path.set_text("");
    }

    fn take_cached(&self, session: &Weak<Session>, source: &Source) -> Option<DirectoryView> {
        let mut cached = self.cached.borrow_mut();
        cached.retain(|view| view.session.strong_count() > 0);
        if let Source::Sftp { socket } = source
            && !socket.as_deref().is_some_and(crate::sftp::socket_ready)
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
        let index = model.value(&iter, 4).get::<u32>().ok()? as usize;
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

    fn close_preview(&self) {
        self.preview_serial.set(self.preview_serial.get() + 1);
        self.preview_file.take();
        self.content.set_visible_child_name("list");
        for child in self.preview_body.children() {
            self.preview_body.remove(&child);
        }
        self.update_controls();
    }

    fn open_preview(self: &Rc<Self>, path: PathBuf) {
        let Some(session) = self.session.borrow().upgrade() else {
            return;
        };
        let source = session.file_source();
        self.close_preview();
        let serial = self.preview_serial.get();
        self.preview_file.replace(Some(path.clone()));
        self.preview_title.set_text(&file_name(&path));
        self.preview_title
            .set_tooltip_text(Some(&files::display(path.as_os_str())));
        self.show_preview_notice("正在加载预览…");
        self.content.set_visible_child_name("preview");
        self.update_controls();
        let weak = Rc::downgrade(self);
        glib::MainContext::default().spawn_local(async move {
            let result = gio::spawn_blocking(move || read_preview(&source, &path))
                .await
                .unwrap_or_else(|_| Err("文件预览被中断。".into()));
            if let Some(browser) = weak
                .upgrade()
                .filter(|browser| browser.preview_serial.get() == serial)
            {
                browser.show_preview(result);
            }
        });
    }

    fn show_preview(&self, result: Result<Preview, String>) {
        for child in self.preview_body.children() {
            self.preview_body.remove(&child);
        }
        let scroll = gtk::ScrolledWindow::builder()
            .overlay_scrolling(false)
            .build();
        match result {
            Ok(Preview::Text(text)) => {
                let view = gtk::TextView::builder()
                    .editable(false)
                    .cursor_visible(false)
                    .monospace(true)
                    .wrap_mode(gtk::WrapMode::WordChar)
                    .left_margin(12)
                    .right_margin(12)
                    .top_margin(10)
                    .bottom_margin(10)
                    .build();
                if let Some(buffer) = view.buffer() {
                    buffer.set_text(&text);
                }
                scroll.add(&view);
            }
            Ok(Preview::Image(data)) => {
                let image = match crate::agent_render::decode_image(&data) {
                    Ok(image) => image,
                    Err(error) => {
                        self.show_preview_notice(&error);
                        return;
                    }
                };
                let width = self.preview_body.allocated_width().clamp(230, 1200) - 20;
                let scaled = if image.width() > width {
                    let height = (i64::from(image.height()) * i64::from(width)
                        / i64::from(image.width()))
                    .max(1) as i32;
                    image.scale_simple(width, height, gdk_pixbuf::InterpType::Bilinear)
                } else {
                    None
                };
                scroll.add(&gtk::Image::from_pixbuf(scaled.as_ref().or(Some(&image))));
            }
            Err(error) => {
                self.show_preview_notice(&error);
                return;
            }
        }
        self.preview_body.pack_start(&scroll, true, true, 0);
        scroll.show_all();
    }

    fn show_preview_notice(&self, text: &str) {
        let notice = gtk::Label::new(Some(text));
        notice.set_line_wrap(true);
        notice.set_margin_top(16);
        notice.set_margin_start(12);
        notice.set_margin_end(12);
        self.preview_body.pack_start(&notice, false, false, 0);
        notice.show();
    }

    fn choose_transfer(self: &Rc<Self>, button: &gtk::Button, upload: bool) {
        let Some(session) = self.session.borrow().upgrade() else {
            return;
        };
        let target = if upload {
            self.current_path()
        } else {
            self.preview_file
                .borrow()
                .clone()
                .or_else(|| self.selected_file())
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
                            if browser.panel.is_visible()
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
        if path != self.current_path() {
            self.close_preview();
        }
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
            let session = self.session.borrow();
            self.cached
                .borrow_mut()
                .retain(|view| !view.session.ptr_eq(&session));
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
                self.path
                    .set_text(&files::display(directory.path.as_os_str()));
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
            String::static_type(),
            String::static_type(),
            u32::static_type(),
            gdk_pixbuf::Pixbuf::static_type(),
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
                    (2, &modified),
                    (3, &mode),
                    (4, &(index as u32)),
                    (5, icon),
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
        self.download.set_sensitive(
            (selected || self.preview_file.borrow().is_some()) && !self.transferring.get(),
        );
        self.upload.set_sensitive(
            available && self.directory.borrow().is_some() && !self.transferring.get(),
        );
    }
}

enum Preview {
    Text(String),
    Image(Vec<u8>),
}

fn read_preview(source: &Source, path: &Path) -> Result<Preview, String> {
    let image_extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["png", "jpg", "jpeg"]
                .iter()
                .any(|image| ext.eq_ignore_ascii_case(image))
        });
    let size_limit = if image_extension {
        8 * 1024 * 1024
    } else {
        256 * 1024
    };
    let bytes = source.preview(path, size_limit)?;
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(b"\xff\xd8\xff") {
        return Ok(Preview::Image(bytes));
    }
    let text = String::from_utf8(bytes)
        .ok()
        .filter(|text| {
            text.chars()
                .all(|ch| !ch.is_control() || matches!(ch, '\r' | '\n' | '\t'))
        })
        .ok_or("可预览 UTF-8 文本、代码、PNG 和 JPEG。此文件可下载。")?;
    Ok(Preview::Text(text))
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
