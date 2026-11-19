use crate::agent_render::{push_link, web_url};
use crate::files::{self, Source};
use crate::icons::{self, Icon};
use crate::session::Session;
use gtk::prelude::*;
use gtk::{gdk_pixbuf, gio, glib, pango};
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
    if !path.is_absolute() {
        let path = safe_relative(path.to_str()?)?;
        if !context.cwd.is_absolute() {
            return None;
        }
        return Some(context.cwd.join(path));
    }
    for root in [Path::new("/mnt/data"), context.cwd.as_path()] {
        if root.is_absolute()
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
        header.pack_start(&label, true, true, 0);
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
        widget.pack_start(&detail, false, false, 0);
        let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
        body.style_context().add_class("files-preview");
        widget.pack_start(&body, true, true, 0);
        widget.show_all();
        widget.set_no_show_all(true);
        widget.hide();
        let panel = Rc::new(Self {
            widget,
            label,
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
        self.detail.set_text(&format!(
            "预览 · {} / {}",
            tab.selection + 1,
            tab.entries.len()
        ));
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
        self.notice("正在加载预览…");
        match item.as_ref() {
            Artifact::Mermaid(code) => self.show_content(Ok(Content::Mermaid(code.clone()))),
            Artifact::Html(html) => self.show_content(html_preview(html).map(Content::Markup)),
            Artifact::File { source, path } => {
                let (source, path) = (source.clone(), path.clone());
                let weak = Rc::downgrade(self);
                glib::MainContext::default().spawn_local(async move {
                    let result = gio::spawn_blocking(move || read_file(&source, &path))
                        .await
                        .unwrap_or_else(|_| Err("预览读取被中断。".into()));
                    if let Some(panel) = weak.upgrade().filter(|panel| panel.load_id.get() == id) {
                        panel.show_content(result);
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

    fn show_content(&self, content: Result<Content, String>) {
        let content = match content {
            Ok(content) => content,
            Err(error) => {
                self.notice(&error);
                return;
            }
        };
        let is_html = matches!(&content, Content::Markup(_));
        self.clear();
        let scroll = gtk::ScrolledWindow::builder()
            .overlay_scrolling(false)
            .build();
        match content {
            Content::Text(text) => {
                let view = gtk::TextView::builder()
                    .editable(false)
                    .cursor_visible(false)
                    .monospace(true)
                    .wrap_mode(gtk::WrapMode::WordChar)
                    .left_margin(12)
                    .right_margin(12)
                    .top_margin(12)
                    .bottom_margin(12)
                    .build();
                if let Some(buffer) = view.buffer() {
                    buffer.set_text(&text);
                }
                scroll.add(&view);
            }
            Content::Markup(markup) | Content::Markdown(markup) => {
                let label = crate::agent_render::markdown_label();
                label.set_selectable(true);
                label.set_valign(gtk::Align::Start);
                label.set_margin_start(14);
                label.set_margin_end(14);
                label.set_margin_top(14);
                if is_html {
                    label.set_markup(&markup);
                } else {
                    crate::agent_render::set_markdown(&label, &markup);
                }
                scroll.add(&label);
            }
            Content::Image(data, kind) => match crate::agent_render::decode_pixbuf(&data, kind) {
                Ok(image) => self.add_image(&scroll, &image),
                Err(error) => {
                    self.notice(&error);
                    return;
                }
            },
            Content::Mermaid(text) => {
                match crate::mermaid::Diagram::parse(&text).and_then(|diagram| diagram.image()) {
                    Some(image) => self.add_image(&scroll, &image),
                    None => {
                        self.notice("该 Mermaid 图可从会话中查看源码。");
                        return;
                    }
                }
            }
        }
        self.body.pack_start(&scroll, true, true, 0);
        scroll.show_all();
    }

    fn add_image(&self, scroll: &gtk::ScrolledWindow, image: &gdk_pixbuf::Pixbuf) {
        let width = self.body.allocated_width().max(self.widget.width_request()) - 22;
        let resized = if image.width() > width {
            let height = (i64::from(image.height()) * i64::from(width) / i64::from(image.width()))
                .max(1) as i32;
            image.scale_simple(width, height, gdk_pixbuf::InterpType::Bilinear)
        } else {
            None
        };
        let widget = gtk::Image::from_pixbuf(resized.as_ref().or(Some(image)));
        widget.set_valign(gtk::Align::Start);
        widget.set_margin_top(12);
        scroll.add(&widget);
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
    Text(String),
    Markdown(String),
    Markup(String),
    Image(Vec<u8>, &'static str),
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
        return Ok(Content::Image(bytes, "png"));
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Ok(Content::Image(bytes, "jpeg"));
    }
    if ext == "svg" {
        return Ok(Content::Image(bytes, "svg"));
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
        _ => Ok(Content::Text(text)),
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
                output.push_str("</a>");
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
