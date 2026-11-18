use crate::mermaid::Diagram;
use gtk::prelude::*;
use gtk::{gdk, gdk_pixbuf, gio, glib, pango};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd, html};
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

pub fn response(markdown: &str, context: &Context) -> gtk::Box {
    let blocks = gtk::Box::new(gtk::Orientation::Vertical, 10);
    let mut pending = String::new();
    let mut list_depth: u32 = 0;
    let mut automatic_images = 0;
    let mut events = parser(markdown);
    while let Some(event) = events.next() {
        match event {
            Event::Start(Tag::Table(_)) => {
                flush_text(&blocks, &mut pending);
                blocks.add(&table(&mut events));
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                flush_text(&blocks, &mut pending);
                let mut code = String::new();
                for event in events.by_ref() {
                    match event {
                        Event::End(TagEnd::CodeBlock) => break,
                        Event::Text(text) => code.push_str(&text),
                        _ => {}
                    }
                }
                if let CodeBlockKind::Fenced(language) = kind {
                    if language.trim() == "mermaid" {
                        if let Some(diagram) = Diagram::parse(&code) {
                            blocks.add(&diagram_widget(diagram, code));
                            continue;
                        }
                    }
                }
                blocks.add(&code_block(&code));
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                flush_text(&blocks, &mut pending);
                let mut alt = String::new();
                for event in events.by_ref() {
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
                let automatic = relative && automatic_images < 3;
                automatic_images += usize::from(automatic);
                blocks.add(&image(&dest_url, &alt, context, automatic));
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph | TagEnd::Heading(_)) => {
                if matches!(event, Event::End(TagEnd::Heading(_))) {
                    pending.push_str("</b>");
                }
                flush_text(&blocks, &mut pending);
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
                flush_text(&blocks, &mut pending);
            }
            Event::Start(Tag::Item) => {
                pending.push_str(&"   ".repeat(list_depth.saturating_sub(1).min(8) as usize));
                pending.push_str("• ");
            }
            Event::End(TagEnd::Item) => pending.push('\n'),
            Event::SoftBreak => pending.push(' '),
            Event::HardBreak => pending.push('\n'),
            Event::Rule => {
                flush_text(&blocks, &mut pending);
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
    flush_text(&blocks, &mut pending);
    blocks
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

fn flush_text(blocks: &gtk::Box, pending: &mut String) {
    if !pending.trim().is_empty() {
        let label = text("");
        if pango::parse_markup(pending.trim(), '\0').is_ok() {
            label.set_markup(pending.trim());
        } else {
            label.set_text(pending.trim());
        }
        blocks.add(&label);
    }
    pending.clear();
}

fn table(events: &mut Parser<'_>) -> gtk::ScrolledWindow {
    let grid = gtk::Grid::builder().column_homogeneous(true).build();
    grid.style_context().add_class("agent-table");

    let mut row = 0;
    let mut col = 0;
    let mut cell = String::new();
    let mut in_cell = false;
    for event in events.by_ref() {
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
                    grid.attach(&label, col, row, 1, 1);
                }
                col += 1;
            }
            Event::End(TagEnd::TableRow | TagEnd::TableHead) => {
                row += 1;
                col = 0;
            }
            Event::Text(value) | Event::Code(value) if in_cell => cell.push_str(&value),
            Event::End(TagEnd::Table) => break,
            _ => {}
        }
    }
    if row > 100 {
        grid.attach(&text("此处显示前 100 行，可复制完整表格。"), 0, 100, 1, 1);
    }
    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Automatic)
        .vscrollbar_policy(gtk::PolicyType::Never)
        .propagate_natural_height(true)
        .build();
    scroll.add(&grid);
    scroll
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

fn code_block(code: &str) -> gtk::Box {
    let block = gtk::Box::new(gtk::Orientation::Vertical, 4);
    block.style_context().add_class("agent-code");
    let label = text(code);
    label.style_context().add_class("agent-monospace");
    block.add(&label);
    block
}

fn diagram_widget(diagram: Diagram, code: String) -> gtk::Box {
    let block = gtk::Box::new(gtk::Orientation::Vertical, 5);
    block.style_context().add_class("agent-card");
    let actions = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    let copy = gtk::Button::with_label("复制图像");
    let source = gtk::Button::with_label("复制 Mermaid");
    actions.pack_end(&source, false, false, 0);
    actions.pack_end(&copy, false, false, 0);
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
    copy.connect_clicked(move |_| {
        if let Some(image) = diagram.image() {
            clipboard().set_image(&image);
        }
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
    let preview = gtk::Image::new();
    block.add(&preview);
    let actions = gtk::Box::new(gtk::Orientation::Horizontal, 4);
    let load = gtk::Button::with_label("加载预览");
    let copy = gtk::Button::with_label("复制图片");
    copy.set_sensitive(false);
    actions.pack_end(&copy, false, false, 0);
    actions.pack_end(&load, false, false, 0);
    block.add(&actions);

    let socket = context.socket.clone();
    let decoded = Rc::new(RefCell::new(None));
    let copy_source = decoded.clone();
    load.connect_clicked(glib::clone!(
        #[weak]
        preview,
        #[weak]
        status,
        #[weak]
        copy,
        move |load| {
            load.set_sensitive(false);
            let target = target.clone();
            let socket = socket.clone();
            let load = load.downgrade();
            let preview = preview.downgrade();
            let status = status.downgrade();
            let copy = copy.downgrade();
            let decoded = decoded.clone();
            glib::MainContext::default().spawn_local(async move {
                let result = gio::spawn_blocking(move || load_image(&target, socket.as_deref()))
                    .await
                    .unwrap_or_else(|_| Err("图片预览被中断。".into()))
                    .and_then(|bytes| decode_image(&bytes));
                let (Some(load), Some(preview), Some(status), Some(copy)) = (
                    load.upgrade(),
                    preview.upgrade(),
                    status.upgrade(),
                    copy.upgrade(),
                ) else {
                    return;
                };
                match result {
                    Ok(image) => {
                        copy.set_sensitive(true);
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
                        decoded.replace(Some(image));
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
        if let Some(image) = copy_source.borrow().as_ref() {
            clipboard().set_image(image);
        }
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
}
