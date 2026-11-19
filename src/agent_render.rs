use crate::agent_selection::{Part, TextSelection};
use crate::mermaid::Diagram;
use gtk::prelude::*;
use gtk::{gdk, gdk_pixbuf, gio, glib, pango};
use pulldown_cmark::{CodeBlockKind, Event, OffsetIter, Options, Parser, Tag, TagEnd, html};
use std::cell::RefCell;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::rc::Rc;

const MAX_IMAGE: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct Context {
    pub cwd: PathBuf,
    pub socket: Option<PathBuf>,
}

pub fn response(markdown: &str, context: &Context, preview_images: bool) -> TextSelection {
    let blocks = gtk::Box::new(gtk::Orientation::Vertical, 10);
    let mut pending = String::new();
    let mut selectable = Vec::new();
    let mut list_depth: u32 = 0;
    let mut automatic_images = 0;
    let mut events = parser(markdown).into_offset_iter();
    while let Some((event, range)) = events.next() {
        match event {
            Event::Start(Tag::Table(_)) => {
                flush_text(&blocks, &mut pending, &mut selectable);
                blocks.add(&table(&mut events, markdown, range.start, &mut selectable));
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                flush_text(&blocks, &mut pending, &mut selectable);
                let mut code = String::new();
                for (event, _) in events.by_ref() {
                    match event {
                        Event::End(TagEnd::CodeBlock) => break,
                        Event::Text(text) => code.push_str(&text),
                        _ => {}
                    }
                }
                let language = match &kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().unwrap_or("纯文本")
                    }
                    CodeBlockKind::Indented => "纯文本",
                };
                if language == "mermaid" {
                    if let Some(diagram) = Diagram::parse(&code) {
                        blocks.add(&diagram_widget(diagram, code));
                        continue;
                    }
                }
                blocks.add(&code_card(language, &code, None));
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                flush_text(&blocks, &mut pending, &mut selectable);
                let mut alt = String::new();
                for (event, _) in events.by_ref() {
                    match event {
                        Event::End(TagEnd::Image) => break,
                        Event::Text(text) | Event::Code(text) => alt.push_str(&text),
                        _ => {}
                    }
                }
                let relative = Path::new(dest_url.as_ref()).components().all(|part| {
                    matches!(
                        part,
                        std::path::Component::Normal(_) | std::path::Component::CurDir
                    )
                });
                let automatic = preview_images && relative && automatic_images < 3;
                automatic_images += usize::from(automatic);
                blocks.add(&image(&dest_url, &alt, context, automatic));
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph | TagEnd::Heading(_)) => {
                if matches!(event, Event::End(TagEnd::Heading(_))) {
                    pending.push_str("</b>");
                }
                flush_text(&blocks, &mut pending, &mut selectable);
            }
            Event::Start(Tag::Heading { .. } | Tag::Strong) => pending.push_str("<b>"),
            Event::End(TagEnd::Strong) => pending.push_str("</b>"),
            Event::Start(Tag::Emphasis) => pending.push_str("<i>"),
            Event::End(TagEnd::Emphasis) => pending.push_str("</i>"),
            Event::Start(Tag::Strikethrough) => pending.push_str("<s>"),
            Event::End(TagEnd::Strikethrough) => pending.push_str("</s>"),
            Event::Start(Tag::List(_)) => list_depth = list_depth.saturating_add(1),
            Event::End(TagEnd::List(_)) => {
                list_depth = list_depth.saturating_sub(1);
                flush_text(&blocks, &mut pending, &mut selectable);
            }
            Event::Start(Tag::Item) => {
                pending.push_str(&"   ".repeat(list_depth.saturating_sub(1).min(8) as usize));
                pending.push_str("• ");
            }
            Event::End(TagEnd::Item) => pending.push('\n'),
            Event::SoftBreak => pending.push(' '),
            Event::HardBreak => pending.push('\n'),
            Event::Rule => {
                flush_text(&blocks, &mut pending, &mut selectable);
                blocks.add(&gtk::Separator::new(gtk::Orientation::Horizontal));
            }
            Event::Code(text) => {
                pending.push_str("<tt>");
                pending.push_str(&escaped(&text));
                pending.push_str("</tt>");
            }
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => {
                pending.push_str(&escaped(&text))
            }
            _ => {}
        }
    }
    flush_text(&blocks, &mut pending, &mut selectable);
    TextSelection::new(&blocks, selectable)
}

fn escaped(text: &str) -> String {
    glib::markup_escape_text(&text.replace('\0', "�")).to_string()
}

fn parser(markdown: &str) -> Parser<'_> {
    Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
    )
}

fn flush_text(blocks: &gtk::Box, pending: &mut String, selectable: &mut Vec<Part>) {
    if !pending.trim().is_empty() {
        let label = text("");
        label.style_context().add_class("agent-prose");
        if pango::parse_markup(pending.trim(), '\0').is_ok() {
            label.set_markup(pending.trim());
        } else {
            label.set_text(pending.trim());
        }
        selectable.push(Part::new(&label, "\n\n"));
        blocks.add(&label);
    }
    pending.clear();
}

fn table(
    events: &mut OffsetIter<'_>,
    markdown: &str,
    start: usize,
    selectable: &mut Vec<Part>,
) -> gtk::Box {
    let grid = gtk::Grid::builder().column_homogeneous(true).build();
    grid.style_context().add_class("agent-table");

    let mut row = 0;
    let mut col = 0;
    let mut cell = String::new();
    let mut cells = Vec::new();
    let mut rows = Vec::new();
    let mut end = start;
    let mut in_cell = false;
    for (event, range) in events.by_ref() {
        match event {
            Event::Start(Tag::TableCell) => {
                cell.clear();
                in_cell = true;
            }
            Event::End(TagEnd::TableCell) => {
                in_cell = false;
                if row < 100 && col < 20 {
                    let label = text(&cell);
                    label.set_hexpand(true);
                    label.set_width_chars(9);
                    label.set_max_width_chars(48);
                    if row == 0 {
                        label.style_context().add_class("agent-table-head");
                    }
                    let separator = match (row, col) {
                        (0, 0) => "\n\n",
                        (_, 0) => "\n",
                        _ => "\t",
                    };
                    selectable.push(Part::new(&label, separator));
                    grid.attach(&label, col, row, 1, 1);
                }
                cells.push(std::mem::take(&mut cell));
                col += 1;
            }
            Event::End(TagEnd::TableRow | TagEnd::TableHead) => {
                rows.push(std::mem::take(&mut cells));
                row += 1;
                col = 0;
            }
            Event::Text(value) | Event::Code(value) if in_cell => cell.push_str(&value),
            Event::HardBreak | Event::SoftBreak if in_cell => cell.push('\n'),
            Event::End(TagEnd::Table) => {
                end = range.end;
                break;
            }
            _ => {}
        }
    }
    if row > 100 {
        grid.attach(&text("此处显示前 100 行，可复制完整表格。"), 0, 100, 1, 1);
    }
    let scroll = glib::Object::builder::<table_scroll::TableScroll>()
        .property("hscrollbar-policy", gtk::PolicyType::Automatic)
        .property("vscrollbar-policy", gtk::PolicyType::Never)
        .property("overlay-scrolling", false)
        .build();
    scroll.style_context().add_class("agent-table-scroll");
    scroll.add(&grid);
    let block = gtk::Box::new(gtk::Orientation::Vertical, 4);
    let actions = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    let source: Rc<str> = Rc::from(markdown.get(start..end).unwrap_or_default().trim_end());
    let markdown_source = source.clone();
    let md = gtk::Button::with_label("复制 Markdown");
    md.connect_clicked(move |_| clipboard().set_text(&markdown_source));
    let rich = gtk::Button::with_label("复制 HTML");
    rich.set_tooltip_text(Some("复制表格格式，可粘贴到支持富文本的应用"));
    rich.connect_clicked(move |_| copy_rich(source.to_string()));
    let csv = gtk::Button::with_label("复制 CSV");
    csv.connect_clicked(move |_| clipboard().set_text(&table_csv(&rows)));
    actions.pack_end(&md, false, false, 0);
    actions.pack_end(&csv, false, false, 0);
    actions.pack_end(&rich, false, false, 0);
    block.add(&scroll);
    block.add(&actions);
    block
}

mod table_scroll {
    use gtk::glib;
    use gtk::prelude::*;
    use gtk::subclass::prelude::*;

    glib::wrapper! {
        pub struct TableScroll(ObjectSubclass<imp::TableScroll>)
            @extends gtk::ScrolledWindow, gtk::Bin, gtk::Container, gtk::Widget,
            @implements gtk::Buildable;
    }

    mod imp {
        use super::*;

        #[derive(Default)]
        pub struct TableScroll;

        #[glib::object_subclass]
        impl ObjectSubclass for TableScroll {
            const NAME: &'static str = "SpanTableScroll";
            type Type = super::TableScroll;
            type ParentType = gtk::ScrolledWindow;
        }

        impl ObjectImpl for TableScroll {}
        impl ContainerImpl for TableScroll {}
        impl BinImpl for TableScroll {}
        impl ScrolledWindowImpl for TableScroll {}

        impl WidgetImpl for TableScroll {
            fn request_mode(&self) -> gtk::SizeRequestMode {
                gtk::SizeRequestMode::HeightForWidth
            }

            fn preferred_height(&self) -> (i32, i32) {
                self.preferred_height_for_width(self.parent_preferred_width().0)
            }

            fn preferred_height_for_width(&self, width: i32) -> (i32, i32) {
                let scroll = self.obj();
                let Some(viewport) = scroll.child().and_downcast::<gtk::Viewport>() else {
                    return (0, 0);
                };
                let Some(grid) = viewport.child().filter(|child| child.is_visible()) else {
                    return (0, 0);
                };
                // GTK3's scrolled window asks for height without passing the allotted width.
                let minimum_width = grid.preferred_width().0;
                let (minimum, natural) = grid.preferred_height_for_width(width.max(minimum_width));
                let scrollbar = if width < minimum_width {
                    scroll
                        .hscrollbar()
                        .map_or(0, |bar| bar.preferred_height().0)
                } else {
                    0
                };
                (minimum + scrollbar, natural + scrollbar)
            }
        }
    }
}

fn table_csv(rows: &[Vec<String>]) -> String {
    let mut csv = String::new();
    for row in rows {
        for (index, cell) in row.iter().enumerate() {
            if index != 0 {
                csv.push(',');
            }
            if cell.contains([',', '\n', '\r', '"']) {
                csv.push('"');
                csv.push_str(&cell.replace('"', "\"\""));
                csv.push('"');
            } else {
                csv.push_str(cell);
            }
        }
        csv.push_str("\r\n");
    }
    csv
}

pub fn text(value: &str) -> gtk::Label {
    let label = gtk::Label::builder()
        .label(value.replace('\0', "�"))
        .xalign(0.0)
        .selectable(true)
        .wrap(true)
        .build();
    label.set_line_wrap_mode(pango::WrapMode::WordChar);
    label
}

pub struct CodeCard {
    pub panel: gtk::Box,
    pub header: gtk::Box,
    pub copy: gtk::Button,
    pub buffer: gtk::TextBuffer,
    pub scroll: gtk::ScrolledWindow,
}

impl CodeCard {
    pub fn new(title: &str, copy_label: &str) -> Self {
        let block = gtk::Box::new(gtk::Orientation::Vertical, 0);
        block.style_context().add_class("agent-code");

        let header = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        header.style_context().add_class("agent-code-header");
        let language = gtk::Label::new(Some(&crate::agent::limited(title, 240)));
        language.set_ellipsize(pango::EllipsizeMode::Start);
        language.set_tooltip_text(Some(&crate::agent::limited(title, 1024)));
        header.pack_start(&language, false, false, 0);
        let copy = gtk::Button::with_label(copy_label);
        copy.style_context().add_class("quiet-button");
        header.pack_end(&copy, false, false, 0);
        block.add(&header);

        let view = gtk::TextView::builder()
            .editable(false)
            .cursor_visible(false)
            .accepts_tab(false)
            .monospace(true)
            .left_margin(10)
            .right_margin(10)
            .top_margin(8)
            .bottom_margin(8)
            .build();
        view.style_context().add_class("agent-code-view");
        let buffer = view.buffer().expect("code view buffer");
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Automatic)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .build();
        scroll.add(&view);
        block.add(&scroll);
        Self {
            panel: block,
            header,
            copy,
            buffer,
            scroll,
        }
    }

    pub fn size_to(&self, text: &str) {
        let lines = text.lines().take(15).count().max(1) as i32;
        self.scroll.set_height_request(18 * lines + 20);
    }
}

pub fn code_card(language: &str, code: &str, status: Option<&str>) -> gtk::Box {
    let card = CodeCard::new(language, "复制代码");
    card.buffer.set_text(&code.replace('\0', "�"));
    card.size_to(code);
    let buffer = card.buffer.clone();
    card.copy.connect_clicked(move |_| {
        if let Some(text) = buffer.text(&buffer.start_iter(), &buffer.end_iter(), true) {
            clipboard().set_text(&text);
        }
    });
    if let Some(status) = status {
        let footer = gtk::Label::new(Some(status));
        footer.set_xalign(1.0);
        footer.style_context().add_class("agent-code-status");
        card.panel.add(&footer);
    }
    card.panel
}

fn diagram_widget(diagram: Diagram, code: String) -> gtk::Box {
    let block = gtk::Box::new(gtk::Orientation::Vertical, 5);
    block.style_context().add_class("agent-card");
    let actions = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    let copy = gtk::Button::with_label("复制图像");
    let source = gtk::Button::with_label("复制 Mermaid");
    let expand = gtk::Button::with_label("放大");
    let save = gtk::Button::with_label("保存 PNG");
    for button in [&save, &copy, &source, &expand] {
        actions.pack_end(button, false, false, 0);
    }
    let drawing = gtk::DrawingArea::new();
    let (width, height) = diagram.dimensions();
    drawing.set_height_request(height.min(540));
    drawing.set_hexpand(true);
    drawing.set_tooltip_text(Some(&format!("Mermaid · {width} × {height}")));
    let diagram = std::rc::Rc::new(diagram);
    let drawing_diagram = diagram.clone();
    drawing.connect_draw(move |area, cairo| {
        drawing_diagram.draw(cairo, area.allocated_width(), area.allocated_height());
        glib::Propagation::Stop
    });
    let copy_diagram = diagram.clone();
    copy.connect_clicked(move |_| {
        if let Some(image) = copy_diagram.image() {
            clipboard().set_image(&image);
        }
    });
    let expanded = diagram.clone();
    expand.connect_clicked(move |button| {
        if let Some(image) = expanded.image() {
            asset_preview(button, &image, "Mermaid");
        }
    });
    save.connect_clicked(move |button| {
        let Some(image) = diagram.image() else {
            return;
        };
        save_asset(button, "diagram.png", move |path| {
            image
                .savev(path, "png", &[])
                .map_err(|error| error.to_string())
        });
    });
    source.connect_clicked(move |_| clipboard().set_text(&code));
    block.add(&drawing);
    block.add(&actions);
    block
}

pub fn image(path: &str, alt: &str, context: &Context, automatic: bool) -> gtk::Box {
    let block = gtk::Box::new(gtk::Orientation::Vertical, 5);
    block.style_context().add_class("agent-card");
    let status = text(if alt.is_empty() { path } else { alt });
    status.set_tooltip_text(Some(path));
    block.add(&status);

    let target = path
        .strip_prefix("file://")
        .or_else(|| path.strip_prefix("sandbox:"))
        .unwrap_or(path);
    if target.contains("://") || target.is_empty() || target.contains('\0') {
        block.add(&text("图片链接 · 可从 Markdown 复制"));
        return block;
    }
    let target = context.cwd.join(target);
    let filename = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned());
    let preview = gtk::Image::new();
    block.add(&preview);
    let actions = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    let load = gtk::Button::with_label("加载预览");
    let copy = gtk::Button::with_label("复制图片");
    let expand = gtk::Button::with_label("放大");
    let save = gtk::Button::with_label("保存原图");
    for button in [&save, &copy, &expand] {
        button.set_sensitive(false);
    }
    for button in [&save, &copy, &expand, &load] {
        actions.pack_end(button, false, false, 0);
    }
    block.add(&actions);

    let socket = context.socket.clone();
    let decoded = Rc::new(RefCell::new(None::<(gdk_pixbuf::Pixbuf, Rc<Vec<u8>>)>));
    let copy_source = decoded.clone();
    load.connect_clicked(glib::clone!(
        #[weak]
        preview,
        #[weak]
        status,
        #[weak]
        copy,
        #[weak]
        expand,
        #[weak]
        save,
        #[strong]
        decoded,
        move |load| {
            load.set_sensitive(false);
            let target = target.clone();
            let socket = socket.clone();
            let load = load.downgrade();
            let preview = preview.downgrade();
            let status = status.downgrade();
            let copy = copy.downgrade();
            let expand = expand.downgrade();
            let save = save.downgrade();
            let decoded = decoded.clone();
            glib::MainContext::default().spawn_local(async move {
                let result = gio::spawn_blocking(move || load_image(&target, socket.as_deref()))
                    .await
                    .unwrap_or_else(|_| Err("图片预览被中断。".into()))
                    .and_then(|bytes| decode_image(&bytes).map(|image| (image, bytes)));
                let (Some(load), Some(preview), Some(status), Some(copy), Some(expand), Some(save)) = (
                    load.upgrade(),
                    preview.upgrade(),
                    status.upgrade(),
                    copy.upgrade(),
                    expand.upgrade(),
                    save.upgrade(),
                ) else {
                    return;
                };
                match result {
                    Ok((image, bytes)) => {
                        for button in [&copy, &expand, &save] { button.set_sensitive(true); }
                        load.hide();
                        let width = preview.allocated_width().clamp(180, 620);
                        let scale = (f64::from(width) / f64::from(image.width()))
                            .min(340.0 / f64::from(image.height()))
                            .min(1.0);
                        let thumbnail = image.scale_simple(
                            (f64::from(image.width()) * scale).max(1.0) as i32,
                            (f64::from(image.height()) * scale).max(1.0) as i32,
                            gdk_pixbuf::InterpType::Bilinear,
                        );
                        preview.set_from_pixbuf(thumbnail.as_ref().or(Some(&image)));
                        status.set_text(&format!("{} × {}", image.width(), image.height()));
                        decoded.replace(Some((image, Rc::new(bytes))));
                    }
                    Err(error) => {
                        status.set_text(&error);
                        load.set_sensitive(true);
                    }
                }
            });
        }
    ));
    copy.connect_clicked(move |_| {
        if let Some((image, _)) = copy_source.borrow().as_ref() {
            clipboard().set_image(image);
        }
    });
    let expanded = decoded.clone();
    expand.connect_clicked(move |button| {
        if let Some((image, _)) = expanded.borrow().as_ref() {
            asset_preview(button, image, "图片预览");
        }
    });
    save.connect_clicked(move |button| {
        let Some((_, bytes)) = decoded.borrow().as_ref().cloned() else {
            return;
        };
        let name = filename.as_deref().unwrap_or_else(|| {
            if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "image.png"
            } else {
                "image.jpg"
            }
        });
        save_asset(button, name, move |path| {
            std::fs::write(path, &*bytes).map_err(|error| error.to_string())
        });
    });
    if automatic {
        let load = load.downgrade();
        glib::idle_add_local_once(move || {
            if let Some(load) = load.upgrade().filter(|load| load.is_sensitive()) {
                load.emit_clicked();
            }
        });
    }
    block
}

fn asset_preview(button: &gtk::Button, image: &gdk_pixbuf::Pixbuf, title: &str) {
    let parent = button.toplevel().and_downcast::<gtk::Window>();
    let dialog = gtk::Dialog::with_buttons(
        Some(title),
        parent.as_ref(),
        gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
        &[("关闭", gtk::ResponseType::Close)],
    );
    dialog.set_default_size(
        (image.width() + 30).clamp(335, 1000),
        (image.height() + 66).clamp(180, 720),
    );
    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Automatic)
        .vscrollbar_policy(gtk::PolicyType::Automatic)
        .build();
    scroll.add(&gtk::Image::from_pixbuf(Some(image)));
    dialog.content_area().pack_start(&scroll, true, true, 0);
    dialog.connect_response(|dialog, _| dialog.close());
    dialog.show_all();
}

fn save_asset(
    button: &gtk::Button,
    name: &str,
    save: impl Fn(&Path) -> Result<(), String> + 'static,
) {
    let parent = button.toplevel().and_downcast::<gtk::Window>();
    let dialog = gtk::FileChooserDialog::new(
        Some("保存文件"),
        parent.as_ref(),
        gtk::FileChooserAction::Save,
    );
    dialog.add_buttons(&[
        ("取消", gtk::ResponseType::Cancel),
        ("保存", gtk::ResponseType::Accept),
    ]);
    dialog.set_modal(true);
    dialog.set_destroy_with_parent(true);
    dialog.set_do_overwrite_confirmation(true);
    dialog.set_current_name(name);
    dialog.set_default_response(gtk::ResponseType::Accept);
    dialog.connect_response(move |dialog, response| {
        if response == gtk::ResponseType::Accept {
            if let Some(path) = dialog.filename() {
                if let Err(error) = save(&path) {
                    let message = gtk::MessageDialog::new(
                        Some(dialog),
                        gtk::DialogFlags::MODAL,
                        gtk::MessageType::Error,
                        gtk::ButtonsType::Close,
                        &error,
                    );
                    message.connect_response(|message, _| message.close());
                    message.show();
                    return;
                }
            }
        }
        dialog.close();
    });
    dialog.show();
}

fn load_image(path: &Path, socket: Option<&Path>) -> Result<Vec<u8>, String> {
    if let Some(socket) = socket {
        return crate::sftp::read_image(socket, path, MAX_IMAGE);
    }
    if !std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()) {
        return Err("图片路径必须指向普通文件。".into());
    }
    let file = File::open(path).map_err(|e| format!("无法打开图片：{e}"))?;
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return Err("图片路径必须指向普通文件。".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_IMAGE {
        return Err("图片超过 8 MiB 预览上限。".into());
    }
    Ok(bytes)
}

fn decode_image(bytes: &[u8]) -> Result<gdk_pixbuf::Pixbuf, String> {
    let kind = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "jpeg"
    } else {
        return Err("图片预览支持 PNG 和 JPEG。".into());
    };
    let loader = gdk_pixbuf::PixbufLoader::with_type(kind).map_err(|e| e.to_string())?;
    loader.connect_size_prepared(|loader, w, h| {
        let scale = (1200.0 / f64::from(w.max(1)))
            .min(900.0 / f64::from(h.max(1)))
            .min(1.0);
        loader.set_size(
            (f64::from(w) * scale).max(1.0) as i32,
            (f64::from(h) * scale).max(1.0) as i32,
        );
    });
    loader.write(bytes).map_err(|e| e.to_string())?;
    loader.close().map_err(|e| e.to_string())?;
    loader.pixbuf().ok_or_else(|| "无法解码图片。".to_owned())
}

pub fn clipboard() -> gtk::Clipboard {
    gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD)
}

pub fn copy_rich(markdown: String) {
    let formatted = rich_html(&markdown);
    let targets = [
        gtk::TargetEntry::new("text/html", gtk::TargetFlags::empty(), 0),
        gtk::TargetEntry::new("UTF8_STRING", gtk::TargetFlags::empty(), 1),
        gtk::TargetEntry::new("text/plain;charset=utf-8", gtk::TargetFlags::empty(), 1),
    ];
    clipboard().set_with_data(&targets, move |_, selection, target| {
        if target == 0 {
            selection.set(&gdk::Atom::intern("text/html"), 8, formatted.as_bytes());
        } else {
            selection.set_text(&markdown);
        }
    });
}

fn rich_html(markdown: &str) -> String {
    let mut formatted = String::new();
    html::push_html(
        &mut formatted,
        parser(markdown).filter_map(|event| match event {
            Event::Html(text) | Event::InlineHtml(text) => Some(Event::Text(text)),
            Event::Start(Tag::Link { .. } | Tag::Image { .. })
            | Event::End(TagEnd::Link | TagEnd::Image) => None,
            event => Some(event),
        }),
    );
    formatted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rich_clipboard_serializes_tables_without_running_markup() {
        let html = rich_html("| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>");
        assert!(html.contains("<table>"));
        assert!(html.contains("<td>2</td>"));
        assert!(!html.contains("<script>"));
    }

    #[test]
    fn csv_preserves_commas_quotes_and_line_breaks() {
        let rows = vec![vec!["plain".into(), "a,\"b\"\nc".into()]];
        assert_eq!(table_csv(&rows), "plain,\"a,\"\"b\"\"\nc\"\r\n");
    }
}
