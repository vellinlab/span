use crate::agent_render::{self, Context, LINK_END, push_link, web_url};
use crate::agent_selection::vertical_delta;
use crate::files::{self, Source};
use crate::icons::{self, Icon};
use crate::session::Session;
use crate::source_preview::{self, SourceText};
use crate::svg::Svg;
use gtk::gdk::prelude::GdkContextExt;
use gtk::prelude::*;
use gtk::{cairo, gdk, gio, glib, pango};
use std::cell::{Cell, RefCell};
use std::path::{Component, Path, PathBuf};
use std::rc::{Rc, Weak};

const MAX_ARTIFACTS: usize = 12;

#[derive(Clone, PartialEq, Eq)]
pub enum Artifact {
    File { source: Source, path: PathBuf },
    Mermaid(String),
    Html(String),
}

pub type Offer = Rc<dyn Fn(Artifact, bool)>;

impl Artifact {
    pub fn output(link: &str, context: &crate::agent_render::Context) -> Option<Self> {
        let path = if let Some(path) = link.strip_prefix("sandbox:/mnt/data/") {
            let path = safe_relative(path)?;
            Path::new("/mnt/data").join(path)
        } else if link.starts_with("file://") {
            let (path, host) = glib::filename_from_uri(link).ok()?;
            if host
                .as_deref()
                .is_some_and(|host| !host.is_empty() && host != "localhost")
            {
                return None;
            }
            local_output(&path, context)?
        } else {
            local_output(Path::new(link), context)?
        };
        if !is_output(&path) {
            return None;
        }
        Some(Self::host_file(path, context))
    }

    pub fn host_file(path: PathBuf, context: &crate::agent_render::Context) -> Self {
        let source = context
            .socket
            .as_ref()
            .map_or(Source::Local, |socket| Source::Sftp {
                socket: Some(socket.clone()),
            });
        Self::File { path, source }
    }

    pub fn title(&self) -> String {
        match self {
            Self::File { path, .. } => {
                files::display(path.file_name().unwrap_or_else(|| path.as_os_str()))
            }
            Self::Mermaid(_) => "Mermaid 图".into(),
            Self::Html(_) => "HTML 页面".into(),
        }
    }
}

fn safe_relative(path: &str) -> Option<&Path> {
    let value = Path::new(path);
    (!path.is_empty()
        && !path.contains(['\0', ':'])
        && value.components().all(|part| match part {
            Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
            Component::CurDir => true,
            _ => false,
        }))
    .then_some(value)
}

fn local_output(path: &Path, context: &crate::agent_render::Context) -> Option<PathBuf> {
    let absolute = |path: &Path| {
        if cfg!(windows) && context.socket.is_some() {
            path.as_os_str().as_encoded_bytes().starts_with(b"/")
        } else {
            path.is_absolute()
        }
    };
    if !absolute(path) {
        let path = safe_relative(path.to_str()?)?;
        if !absolute(&context.cwd) {
            return None;
        }
        return Some(context.cwd.join(path));
    }
    for root in [Path::new("/mnt/data"), context.cwd.as_path()] {
        if absolute(root)
            && root != Path::new("/")
            && let Ok(relative) = path.strip_prefix(root)
            && safe_relative(relative.to_str()?).is_some()
        {
            return Some(path.to_owned());
        }
    }
    None
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_output(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "svg"
            | "html"
            | "htm"
            | "md"
            | "markdown"
            | "txt"
            | "csv"
            | "tsv"
            | "pdf"
            | "json"
            | "mmd"
            | "mermaid"
    )
}

#[derive(Default)]
struct History {
    owner: Weak<Session>,
    entries: Vec<Rc<Artifact>>,
    selection: usize,
    open: bool,
    manual: bool,
}

pub struct Panel {
    pub widget: gtk::Box,
    label: gtk::Label,
    location: gtk::Label,
    detail: gtk::Label,
    body: gtk::Box,
    previous: gtk::Button,
    next: gtk::Button,
    save: gtk::Button,
    owner: RefCell<Weak<Session>>,
    history: RefCell<Vec<History>>,
    load_id: Cell<u64>,
    refresh_pending: Cell<bool>,
}

impl Panel {
    pub fn new() -> Rc<Self> {
        let widget = gtk::Box::new(gtk::Orientation::Vertical, 0);
        widget.style_context().add_class("preview-panel");
        if let Some(accessible) = widget.accessible() {
            accessible.set_name("预览区");
        }
        widget.set_width_request(232);
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 3);
        header.style_context().add_class("files-preview-header");
        let label = gtk::Label::builder()
            .label("预览区")
            .xalign(0.0)
            .ellipsize(pango::EllipsizeMode::Middle)
            .build();
        label.style_context().add_class("section-title");
        let file_name = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        file_name.style_context().add_class("preview-file-name");
        file_name.pack_start(&icons::widget(Icon::File, 14), false, false, 0);
        file_name.pack_start(&label, true, true, 0);
        header.pack_start(&file_name, true, true, 0);
        let previous = tool("‹", "上一个预览");
        let next = tool("›", "下一个预览");
        let save = tool("", "保存预览文件");
        save.add(&icons::widget(Icon::Download, 15));
        let close = tool("", "关闭预览");
        close.add(&icons::widget(Icon::Close, 15));
        for button in [&previous, &next, &save, &close] {
            header.pack_start(button, false, false, 0);
        }
        widget.pack_start(&header, false, false, 0);
        let detail = gtk::Label::builder()
            .xalign(0.0)
            .ellipsize(pango::EllipsizeMode::End)
            .build();
        detail.style_context().add_class("preview-detail");
        let location = gtk::Label::builder()
            .xalign(0.0)
            .ellipsize(pango::EllipsizeMode::Start)
            .build();
        let path_bar = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        path_bar.style_context().add_class("preview-location");
        path_bar.pack_start(&location, true, true, 0);
        path_bar.pack_end(&detail, false, false, 0);
        widget.pack_start(&path_bar, false, false, 0);
        let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
        body.style_context().add_class("files-preview");
        widget.pack_start(&body, true, true, 0);
        widget.show_all();
        widget.set_no_show_all(true);
        widget.hide();
        let panel = Rc::new(Self {
            widget,
            label,
            location,
            detail,
            body,
            previous,
            next,
            save,
            owner: RefCell::new(Weak::new()),
            history: RefCell::new(Vec::new()),
            load_id: Cell::new(0),
            refresh_pending: Cell::new(false),
        });
        let weak = Rc::downgrade(&panel);
        close.connect_clicked(move |_| {
            if let Some(panel) = weak.upgrade() {
                if let Some(history) = panel.active(&mut panel.history.borrow_mut()) {
                    history.open = false;
                    history.manual = false;
                }
                panel.hide();
            }
        });
        for (button, step) in [(&panel.previous, -1), (&panel.next, 1)] {
            let weak = Rc::downgrade(&panel);
            button.connect_clicked(move |_| {
                if let Some(panel) = weak.upgrade() {
                    panel.step(step);
                }
            });
        }
        let weak = Rc::downgrade(&panel);
        panel.save.connect_clicked(move |button| {
            if let Some(panel) = weak.upgrade() {
                panel.save_file(button);
            }
        });
        panel
    }

    pub fn select(self: &Rc<Self>, owner: Option<&Rc<Session>>) {
        let owner = owner.map(Rc::downgrade).unwrap_or_default();
        if !self.owner.borrow().ptr_eq(&owner) {
            self.owner.replace(owner);
            self.refresh();
        }
    }

    pub fn offer(self: &Rc<Self>, owner: &Rc<Session>, item: Artifact, automatic: bool) {
        let owner = Rc::downgrade(owner);
        let mut tabs = self.history.borrow_mut();
        tabs.retain(|tab| tab.owner.strong_count() > 0);
        let index = tabs
            .iter()
            .position(|tab| tab.owner.ptr_eq(&owner))
            .unwrap_or_else(|| {
                tabs.push(History {
                    owner: owner.clone(),
                    ..History::default()
                });
                tabs.len() - 1
            });
        let tab = &mut tabs[index];
        let index = if let Some(index) = tab.entries.iter().position(|entry| **entry == item) {
            if automatic {
                return;
            }
            index
        } else {
            if tab.entries.len() == MAX_ARTIFACTS {
                let remove = usize::from(tab.selection == 0);
                tab.entries.remove(remove);
                if tab.selection > remove {
                    tab.selection -= 1;
                }
            }
            tab.entries.push(Rc::new(item));
            tab.entries.len() - 1
        };
        let reveal = !(automatic && tab.manual);
        if reveal {
            tab.selection = index;
            tab.open = true;
            tab.manual = !automatic;
        }
        let active = self.owner.borrow().ptr_eq(&owner);
        if active {
            self.update_actions(tab);
        }
        drop(tabs);
        if reveal && active {
            if automatic {
                if !self.refresh_pending.replace(true) {
                    let weak = Rc::downgrade(self);
                    glib::idle_add_local_once(move || {
                        if let Some(panel) = weak.upgrade() {
                            panel.refresh_pending.set(false);
                            panel.refresh();
                        }
                    });
                }
            } else {
                self.refresh();
            }
        }
    }

    fn active<'a>(&self, tabs: &'a mut [History]) -> Option<&'a mut History> {
        let owner = self.owner.borrow();
        tabs.iter_mut().find(|tab| tab.owner.ptr_eq(&owner))
    }

    fn step(self: &Rc<Self>, step: isize) {
        if let Some(tab) = self.active(&mut self.history.borrow_mut()) {
            tab.selection = tab
                .selection
                .saturating_add_signed(step)
                .min(tab.entries.len().saturating_sub(1));
            tab.manual = true;
        }
        self.refresh();
    }

    fn update_actions(&self, tab: &History) {
        self.previous.set_sensitive(tab.selection > 0);
        self.next
            .set_sensitive(tab.selection + 1 < tab.entries.len());
        self.save.set_sensitive(
            tab.entries
                .get(tab.selection)
                .is_some_and(|asset| matches!(**asset, Artifact::File { .. })),
        );
        self.detail
            .set_text(&format!("{} / {}", tab.selection + 1, tab.entries.len()));
    }

    fn refresh(self: &Rc<Self>) {
        let item = self.active(&mut self.history.borrow_mut()).and_then(|tab| {
            self.update_actions(tab);
            if tab.open {
                tab.entries.get(tab.selection).cloned()
            } else {
                None
            }
        });
        let Some(item) = item else {
            self.hide();
            return;
        };
        self.load_id.set(self.load_id.get() + 1);
        let id = self.load_id.get();
        self.widget.show();
        self.label.set_text(&item.title());
        self.label.set_tooltip_text(Some(&item.title()));
        let location = match item.as_ref() {
            Artifact::File { path, .. } => path.parent().map(|dir| files::display(dir.as_os_str())),
            _ => None,
        };
        self.location
            .set_text(location.as_deref().unwrap_or_default());
        self.location.set_tooltip_text(location.as_deref());
        self.notice("正在加载预览…");
        match item.as_ref() {
            Artifact::Mermaid(code) => self.show_content(Ok(Content::Mermaid(code.clone())), None),
            Artifact::Html(html) => {
                self.show_content(html_preview(html).map(Content::Markup), None)
            }
            Artifact::File { source, path } => {
                let context = Context {
                    cwd: path
                        .parent()
                        .unwrap_or_else(|| Path::new("/"))
                        .to_path_buf(),
                    socket: match source {
                        Source::Local => None,
                        Source::Sftp { socket } => socket.clone(),
                    },
                };
                let (source, path) = (source.clone(), path.clone());
                let weak = Rc::downgrade(self);
                glib::MainContext::default().spawn_local(async move {
                    let result = gio::spawn_blocking(move || read_file(&source, &path))
                        .await
                        .unwrap_or_else(|_| Err("预览读取被中断。".into()));
                    if let Some(panel) = weak.upgrade().filter(|panel| panel.load_id.get() == id) {
                        panel.show_content(result, Some(context));
                    }
                });
            }
        }
    }

    fn hide(&self) {
        self.load_id.set(self.load_id.get() + 1);
        self.widget.hide();
        self.clear();
    }

    fn clear(&self) {
        for child in self.body.children() {
            self.body.remove(&child);
        }
    }

    fn notice(&self, text: &str) {
        self.clear();
        let label = gtk::Label::new(Some(text));
        label.set_line_wrap(true);
        label.set_margin_start(12);
        label.set_margin_end(12);
        label.set_margin_top(16);
        self.body.pack_start(&label, false, false, 0);
        label.show();
    }

    fn show_content(self: &Rc<Self>, content: Result<Content, String>, context: Option<Context>) {
        let content = match content {
            Ok(content) => content,
            Err(error) => {
                self.notice(&error);
                return;
            }
        };
        self.clear();
        let scroll = gtk::ScrolledWindow::builder()
            .overlay_scrolling(false)
            .build();
        let owner = self.owner.borrow().clone();
        let quote: crate::quote::Action = Rc::new(move |text| {
            if let Some(session) = owner.upgrade() {
                session.quote(text);
            }
        });
        match content {
            Content::Text(source) => {
                let view = source_preview::view(&scroll, source, &quote);
                self.body.pack_start(&view, true, true, 0);
                view.show_all();
                return;
            }
            Content::Markup(markup) => {
                let label = agent_render::markdown_label();
                label.set_selectable(true);
                label.set_valign(gtk::Align::Start);
                label.set_margin_start(14);
                label.set_margin_end(14);
                label.set_margin_top(14);
                label.set_markup(&markup);
                crate::quote::bind_label(&label, &quote);
                scroll.add(&label);
            }
            Content::Markdown(text) => {
                let context = context.expect("Markdown comes from a preview file");
                let owner = self.owner.borrow().clone();
                let panel = Rc::downgrade(self);
                let offer: Offer = Rc::new(move |artifact, automatic| {
                    if let (Some(panel), Some(session)) = (panel.upgrade(), owner.upgrade()) {
                        panel.offer(&session, artifact, automatic);
                    }
                });
                let view = agent_render::response(
                    &text,
                    &context,
                    agent_render::ResponseMode::Preview,
                    None,
                    &offer,
                    &quote,
                );
                view.style_context().add_class("agent-response");
                view.set_valign(gtk::Align::Start);
                view.set_margin_start(12);
                view.set_margin_end(12);
                view.set_margin_top(12);
                view.set_margin_bottom(12);
                scroll.add(&view);
            }
            Content::Image(pixels) => {
                let image = pixels.pixbuf();
                self.add_image(&scroll, (image.width(), image.height()), move |cr| {
                    cr.set_source_pixbuf(&image, 0.0, 0.0);
                    let _ = cr.paint();
                });
            }
            Content::Svg(data) => match Svg::new(&data) {
                Ok(svg) => self.add_image(&scroll, svg.dimensions(), move |cr| {
                    svg.draw(cr);
                }),
                Err(error) => {
                    self.notice(&error);
                    return;
                }
            },
            Content::Mermaid(text) => match crate::mermaid::Diagram::parse(&text) {
                Some(diagram) => {
                    let size = diagram.dimensions();
                    self.add_image(&scroll, size, move |cr| diagram.draw(cr, size.0, size.1));
                }
                None => {
                    self.notice("该 Mermaid 图可从会话中查看源码。");
                    return;
                }
            },
        }
        self.body.pack_start(&scroll, true, true, 0);
        scroll.show_all();
    }

    fn add_image(
        &self,
        scroll: &gtk::ScrolledWindow,
        size: (i32, i32),
        draw: impl Fn(&cairo::Context) + 'static,
    ) {
        let toolbar = gtk::Box::new(gtk::Orientation::Horizontal, 2);
        toolbar.style_context().add_class("preview-zoom");
        let zoom_out = tool("−", "缩小图片");
        let zoom_in = tool("+", "放大图片");
        let actual = tool("100%", "原始大小");
        let fit = tool("适合宽度", "适合宽度");
        let level = gtk::Label::new(None);
        for button in [&zoom_out, &zoom_in, &actual, &fit] {
            toolbar.pack_start(button, false, false, 0);
        }
        toolbar.pack_end(&level, false, false, 0);
        self.body.pack_start(&toolbar, false, false, 0);
        toolbar.show_all();

        let canvas = gtk::DrawingArea::new();
        if let Some(accessible) = canvas.accessible() {
            accessible.set_name("图片画布");
        }
        canvas.set_halign(gtk::Align::Center);
        canvas.set_valign(gtk::Align::Start);
        canvas.set_margin_top(10);
        canvas.set_margin_bottom(10);
        canvas.set_margin_start(8);
        canvas.set_margin_end(8);
        let scale = Rc::new(Cell::new(0.0));
        let paint_scale = scale.clone();
        let (width, height) = (f64::from(size.0), f64::from(size.1));
        canvas.connect_draw(move |_, cr| {
            let _ = cr.save();
            let factor = paint_scale.get();
            cr.scale(factor, factor);
            cr.rectangle(0.0, 0.0, width, height);
            cr.clip();
            draw(cr);
            let _ = cr.restore();
            glib::Propagation::Stop
        });
        scroll.add(&canvas);

        let auto_fit = Rc::new(Cell::new(true));
        let canvas = canvas.downgrade();
        let level = level.downgrade();
        let applied = scale.clone();
        // Bound the logical canvas as well as the magnification for large SVGs.
        let max_factor = (32_000.0 / width.max(height)).min(4.0);
        let update = Rc::new(move |factor: f64| {
            let factor = factor.clamp(0.02_f64.min(max_factor), max_factor);
            if applied.replace(factor) != factor {
                if let Some(canvas) = canvas.upgrade() {
                    canvas.set_size_request(
                        (width * factor).ceil() as i32,
                        (height * factor).ceil() as i32,
                    );
                    canvas.queue_draw();
                }
                if let Some(level) = level.upgrade() {
                    level.set_text(&format!("{:.0}%", factor * 100.0));
                }
            }
        });
        let fit_factor =
            move |available: i32| (f64::from((available - 24).max(40)) / width).min(1.0);
        update(fit_factor(
            self.body.allocated_width().max(self.widget.width_request()),
        ));
        let fit_pending = auto_fit.clone();
        let resize = update.clone();
        scroll.connect_size_allocate(move |_, allocation| {
            if fit_pending.get() {
                resize(fit_factor(allocation.width()));
            }
        });
        let (zoom, current, wheel_fit) = (update.clone(), scale.clone(), auto_fit.clone());
        scroll.connect_scroll_event(move |_, event| {
            if event.state().contains(gdk::ModifierType::CONTROL_MASK)
                && let Some(delta) = vertical_delta(event)
            {
                wheel_fit.set(false);
                zoom(current.get() * 1.25_f64.powf(-delta.clamp(-4.0, 4.0)));
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        for (button, multiplier) in [(&zoom_out, 0.8), (&zoom_in, 1.25), (&actual, 0.0)] {
            let (update, scale, auto_fit) = (update.clone(), scale.clone(), auto_fit.clone());
            button.connect_clicked(move |_| {
                auto_fit.set(false);
                update(if multiplier == 0.0 {
                    1.0
                } else {
                    scale.get() * multiplier
                });
            });
        }
        let scroll = scroll.downgrade();
        fit.connect_clicked(move |_| {
            auto_fit.set(true);
            if let Some(scroll) = scroll.upgrade() {
                update(fit_factor(scroll.allocated_width()));
            }
        });
    }

    fn save_file(self: &Rc<Self>, button: &gtk::Button) {
        let asset = self
            .active(&mut self.history.borrow_mut())
            .and_then(|tab| tab.entries.get(tab.selection).cloned());
        let Some(Artifact::File { source, path }) = asset.as_deref() else {
            return;
        };
        let (source, path) = (source.clone(), path.clone());
        let parent = button.toplevel().and_downcast::<gtk::Window>();
        let dialog = gtk::FileChooserDialog::new(
            Some("保存预览文件"),
            parent.as_ref(),
            gtk::FileChooserAction::Save,
        );
        dialog.add_buttons(&[
            ("取消", gtk::ResponseType::Cancel),
            ("保存", gtk::ResponseType::Accept),
        ]);
        dialog.set_do_overwrite_confirmation(true);
        dialog.set_current_name(&files::display(
            path.file_name().unwrap_or_else(|| path.as_os_str()),
        ));
        dialog.set_modal(true);
        dialog.set_destroy_with_parent(true);
        let weak = Rc::downgrade(self);
        dialog.connect_response(move |dialog, response| {
            if response == gtk::ResponseType::Accept
                && let Some(destination) = dialog.filename()
            {
                let (source, path, weak) = (source.clone(), path.clone(), weak.clone());
                let id = weak.upgrade().map(|panel| {
                    panel.detail.set_text("正在保存文件…");
                    panel.load_id.get()
                });
                glib::MainContext::default().spawn_local(async move {
                    let result = gio::spawn_blocking(move || source.download(&path, &destination))
                        .await
                        .unwrap_or_else(|_| Err("保存文件被中断。".into()));
                    if let Some(panel) = weak
                        .upgrade()
                        .filter(|panel| Some(panel.load_id.get()) == id)
                    {
                        panel
                            .detail
                            .set_text(result.as_ref().err().map_or("已保存文件", String::as_str));
                    }
                });
            }
            dialog.close();
        });
        dialog.show();
    }
}

fn tool(text: &str, name: &str) -> gtk::Button {
    let button = if text.is_empty() {
        gtk::Button::new()
    } else {
        gtk::Button::with_label(text)
    };
    button.style_context().add_class("quiet-button");
    button.set_tooltip_text(Some(name));
    if let Some(accessible) = button.accessible() {
        accessible.set_name(name);
    }
    button
}

enum Content {
    Text(SourceText),
    Markdown(String),
    Markup(String),
    Image(agent_render::ImagePixels),
    Svg(Vec<u8>),
    Mermaid(String),
}

fn read_file(source: &Source, path: &Path) -> Result<Content, String> {
    let ext = extension(path);
    let limit = match ext.as_str() {
        "png" | "jpg" | "jpeg" => 8 * 1024 * 1024,
        "html" | "htm" | "svg" => 1024 * 1024,
        _ => 256 * 1024,
    };
    let bytes = source.preview(path, limit)?;
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return agent_render::preview_pixels(&bytes, "png").map(Content::Image);
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return agent_render::preview_pixels(&bytes, "jpeg").map(Content::Image);
    }
    if ext == "svg" {
        return Ok(Content::Svg(bytes));
    }
    let text = String::from_utf8(bytes)
        .ok()
        .filter(|text| {
            text.chars()
                .all(|ch| !ch.is_control() || matches!(ch, '\r' | '\n' | '\t'))
        })
        .ok_or("这种文件可保存到本机查看。")?;
    match ext.as_str() {
        "html" | "htm" => html_preview(&text).map(Content::Markup),
        "md" | "markdown" => Ok(Content::Markdown(text)),
        "mmd" | "mermaid" => Ok(Content::Mermaid(text)),
        _ => Ok(Content::Text(SourceText::new(path, text))),
    }
}

fn html_preview(source: &str) -> Result<String, String> {
    let dom =
        tl::parse(source, tl::ParserOptions::default()).map_err(|_| "无法读取 HTML 页面。")?;
    let mut markup = String::new();
    let parser = dom.parser();
    for handle in dom.children() {
        if let Some(node) = handle.get(parser) {
            html_node(node, parser, 0, &mut markup);
        }
    }
    let text = markup.trim();
    if text.is_empty() {
        return Err("页面没有可供静态预览的内容。".into());
    }
    Ok(text.to_owned())
}

fn html_node(node: &tl::Node<'_>, parser: &tl::Parser<'_>, depth: usize, output: &mut String) {
    if depth > 48 || output.len() > 256 * 1024 {
        return;
    }
    match node {
        tl::Node::Comment(_) => {}
        tl::Node::Raw(text) => {
            let text = html_text(&text.as_utf8_str());
            let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !collapsed.is_empty() {
                if text.starts_with(char::is_whitespace) && !output.ends_with([' ', '\n']) {
                    output.push(' ');
                }
                output.push_str(&glib::markup_escape_text(&collapsed));
                if text.ends_with(char::is_whitespace) {
                    output.push(' ');
                }
            }
        }
        tl::Node::Tag(tag) => {
            let name = tag.name().as_utf8_str().to_ascii_lowercase();
            let href = (name == "a")
                .then(|| tag.attributes().get("href").flatten())
                .flatten()
                .map(|url| html_text(&url.as_utf8_str()))
                .filter(|url| web_url(url));
            let (begin, end) = match name.as_str() {
                "head" | "style" | "script" | "iframe" | "svg" | "template" | "noscript" => return,
                "h1" => ("\n\n<span size=\"x-large\" weight=\"bold\">", "</span>\n"),
                "h2" | "h3" | "h4" => ("\n\n<big><b>", "</b></big>\n"),
                "p" | "article" | "section" | "blockquote" | "header" | "footer" => ("\n\n", "\n"),
                "div" | "tr" | "ul" | "ol" => ("\n", "\n"),
                "li" => ("\n• ", ""),
                "td" | "th" => ("", "   "),
                "pre" => ("\n<tt>", "</tt>\n"),
                "code" => ("<tt>", "</tt>"),
                "b" | "strong" => ("<b>", "</b>"),
                "i" | "em" => ("<i>", "</i>"),
                "br" => ("\n", ""),
                _ => ("", ""),
            };
            output.push_str(begin);
            if let Some(href) = &href {
                push_link(output, href);
            }
            for handle in tag.children().top().iter() {
                if let Some(child) = handle.get(parser) {
                    html_node(child, parser, depth + 1, output);
                }
            }
            if href.is_some() {
                output.push_str(LINK_END);
            }
            output.push_str(end);
        }
    }
}

fn html_text(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}
