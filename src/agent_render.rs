use crate::agent_selection::{Part, TextSelection, scroll_vertical, vertical_delta};
use crate::mermaid::Diagram;
use crate::preview::{Artifact, Offer};
use crate::quote;
use gtk::atk::prelude::{HyperlinkExt, HypertextExt};
use gtk::prelude::*;
use gtk::{cairo, gdk, gdk_pixbuf, gio, glib, pango};
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
    pub socket: Option<crate::ssh::ChannelBuf>,
}

pub fn response(
    markdown: &str,
    context: &Context,
    live: bool,
    preview: &Offer,
    quote: &quote::Action,
) -> TextSelection {
    let blocks = gtk::Box::new(gtk::Orientation::Vertical, 10);
    let context = Rc::new(context.clone());
    let prose_label = || {
        let context = context.clone();
        let preview = preview.clone();
        markdown_label_with(move |label, uri| {
            if let Some(artifact) = Artifact::output(uri, &context) {
                preview(artifact, false);
            } else {
                open_link(label, uri);
            }
        })
    };
    let mut pending = String::new();
    let mut selectable = Vec::new();
    let mut list_depth: u32 = 0;
    let mut link = false;
    let mut automatic_images = 0;
    let mut artifacts = Vec::new();
    let mut events = parser(markdown).into_offset_iter();
    while let Some((event, range)) = events.next() {
        match event {
            Event::Start(Tag::Table(_)) => {
                flush_text(&blocks, &mut pending, &mut selectable, &prose_label);
                blocks.add(&table(&mut events, markdown, range.start, &mut selectable));
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                flush_text(&blocks, &mut pending, &mut selectable, &prose_label);
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
                        artifacts.push(Artifact::Mermaid(code.clone()));
                        blocks.add(&diagram_widget(diagram, code));
                        continue;
                    }
                }
                if matches!(language, "html" | "htm") && !code.trim().is_empty() {
                    artifacts.push(Artifact::Html(code.clone()));
                }
                blocks.add(&code_card(language, &code, None, quote));
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                let mut alt = String::new();
                for (event, _) in events.by_ref() {
                    match event {
                        Event::End(TagEnd::Image) => break,
                        Event::Text(text) | Event::Code(text) => alt.push_str(&text),
                        _ => {}
                    }
                }
                if link {
                    pending.push_str(&escaped(&alt));
                    continue;
                }
                flush_text(&blocks, &mut pending, &mut selectable, &prose_label);
                let relative = Path::new(dest_url.as_ref()).components().all(|part| {
                    matches!(
                        part,
                        std::path::Component::Normal(_) | std::path::Component::CurDir
                    )
                });
                let automatic = live && relative && automatic_images < 3;
                automatic_images += usize::from(automatic);
                if let Some(artifact) = Artifact::output(&dest_url, &context) {
                    artifacts.push(artifact);
                }
                blocks.add(&image(&dest_url, &alt, &context, automatic));
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                let artifact = Artifact::output(&dest_url, &context);
                link = web_url(&dest_url) || artifact.is_some();
                if link {
                    push_link(&mut pending, &dest_url);
                }
                artifacts.extend(artifact);
            }
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph | TagEnd::Heading(_)) => {
                if matches!(event, Event::End(TagEnd::Heading(_))) {
                    pending.push_str("</b>");
                }
                flush_text(&blocks, &mut pending, &mut selectable, &prose_label);
            }
            Event::Start(Tag::Heading { .. }) => pending.push_str("<b>"),
            Event::Start(Tag::List(_)) => list_depth = list_depth.saturating_add(1),
            Event::End(TagEnd::List(_)) => {
                list_depth = list_depth.saturating_sub(1);
                flush_text(&blocks, &mut pending, &mut selectable, &prose_label);
            }
            Event::Start(Tag::Item) => {
                pending.push_str(&"   ".repeat(list_depth.saturating_sub(1).min(8) as usize));
                pending.push_str("• ");
            }
            Event::End(TagEnd::Item) => pending.push('\n'),
            Event::Rule => {
                flush_text(&blocks, &mut pending, &mut selectable, &prose_label);
                blocks.add(&gtk::Separator::new(gtk::Orientation::Horizontal));
            }
            event => inline(&mut pending, event, &mut link),
        }
    }
    flush_text(&blocks, &mut pending, &mut selectable, &prose_label);
    if !artifacts.is_empty() {
        let actions = gtk::Box::new(gtk::Orientation::Vertical, 2);
        actions.style_context().add_class("agent-preview-actions");
        let mut unique = Vec::new();
        for artifact in artifacts {
            if !unique.contains(&artifact) {
                unique.push(artifact);
            }
        }
        for artifact in unique.into_iter().take(8) {
            if live {
                preview(artifact.clone(), true);
            }
            actions.add(&artifact_button(artifact, preview.clone()));
        }
        blocks.add(&actions);
    }
    TextSelection::new(&blocks, selectable, quote)
}

pub fn artifact_button(artifact: Artifact, preview: Offer) -> gtk::Button {
    let label = format!("右侧预览 · {}", artifact.title());
    let button = gtk::Button::with_label(&label);
    button.set_halign(gtk::Align::Start);
    button.style_context().add_class("quiet-button");
    button.connect_clicked(move |_| preview(artifact.clone(), false));
    button
}

fn escaped(text: &str) -> String {
    glib::markup_escape_text(&text.replace('\0', "�")).to_string()
}

fn inline(markup: &mut String, event: Event<'_>, link: &mut bool) {
    match event {
        Event::Start(Tag::Strong) => markup.push_str("<b>"),
        Event::End(TagEnd::Strong) => markup.push_str("</b>"),
        Event::Start(Tag::Emphasis) => markup.push_str("<i>"),
        Event::End(TagEnd::Emphasis) => markup.push_str("</i>"),
        Event::Start(Tag::Strikethrough) => markup.push_str("<s>"),
        Event::End(TagEnd::Strikethrough) => markup.push_str("</s>"),
        Event::Start(Tag::Link { dest_url, .. }) => {
            *link = web_url(&dest_url);
            if *link {
                push_link(markup, &dest_url);
            }
        }
        Event::End(TagEnd::Link) => {
            if std::mem::take(link) {
                markup.push_str(LINK_END);
            }
        }
        Event::Code(text) => markup.push_str(&format!("<tt>{}</tt>", escaped(&text))),
        Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => {
            markup.push_str(&escaped(&text));
        }
        Event::SoftBreak => markup.push(' '),
        Event::HardBreak => markup.push('\n'),
        _ => {}
    }
}

pub(crate) const LINK_END: &str = "</span></a>";

pub(crate) fn push_link(markup: &mut String, uri: &str) {
    markup.push_str("<a href=\"");
    markup.push_str(&escaped(uri));
    markup.push_str("\"><span underline=\"none\">");
}

pub(crate) fn web_url(uri: &str) -> bool {
    uri.split_once("://").is_some_and(|(scheme, rest)| {
        (scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http"))
            && !rest.is_empty()
            && !rest.chars().any(char::is_whitespace)
            && !rest.chars().any(char::is_control)
    })
}

pub(crate) fn open_link(widget: &impl IsA<gtk::Widget>, uri: &str) {
    if !web_url(uri) {
        return;
    }
    let Err(error) = gio::AppInfo::launch_default_for_uri(uri, gio::AppLaunchContext::NONE) else {
        return;
    };
    let parent = widget.toplevel().and_downcast::<gtk::Window>();
    let dialog = gtk::MessageDialog::new(
        parent.as_ref(),
        gtk::DialogFlags::DESTROY_WITH_PARENT | gtk::DialogFlags::MODAL,
        gtk::MessageType::Error,
        gtk::ButtonsType::None,
        "无法用默认浏览器打开链接",
    );
    dialog.set_property("secondary-text", error.message());
    dialog.add_buttons(&[
        ("关闭", gtk::ResponseType::Close),
        ("复制链接", gtk::ResponseType::Accept),
    ]);
    let uri = uri.to_owned();
    dialog.connect_response(move |dialog, response| {
        if response == gtk::ResponseType::Accept {
            clipboard().set_text(&uri);
        }
        dialog.close();
    });
    dialog.show();
}

pub fn markdown_label() -> gtk::Label {
    markdown_label_with(open_link)
}

fn markdown_label_with(activate: impl Fn(&gtk::Label, &str) + 'static) -> gtk::Label {
    let label = text("");
    label.style_context().add_class("agent-markdown");
    label.connect_activate_link(move |label, uri| {
        activate(label, uri);
        glib::Propagation::Stop
    });
    label.connect_draw(|label, cr| {
        draw_link_underlines(label, cr);
        glib::Propagation::Proceed
    });
    label
}

fn draw_link_underlines(label: &gtk::Label, cr: &cairo::Context) {
    if !label.label().contains("<a href=") {
        return;
    }
    let Some(links) = label
        .accessible()
        .and_then(|object| object.dynamic_cast::<gtk::atk::Hypertext>().ok())
    else {
        return;
    };
    let ranges: Vec<_> = (0..links.n_links())
        .filter_map(|index| links.link(index))
        .map(|link| (link.start_index(), link.end_index()))
        .collect();
    let Some(layout) = label.layout().filter(|_| !ranges.is_empty()) else {
        return;
    };
    let (x, y) = label.layout_offsets();
    let allocation = label.allocation();
    let (x, y) = (f64::from(x - allocation.x()), f64::from(y - allocation.y()));
    let pixels = |units: i32| f64::from(units) / f64::from(pango::SCALE);
    let context = label.style_context();
    let color = context
        .lookup_color("accent")
        .unwrap_or_else(|| context.color(context.state()));
    cr.set_source_rgba(
        f64::from(color.red()),
        f64::from(color.green()),
        f64::from(color.blue()),
        f64::from(color.alpha()),
    );
    let mut iter = layout.iter();
    let mut ranges = ranges.as_slice();
    while let Some(line) = iter.line_readonly() {
        let start = line.start_index();
        let end = start + line.length();
        while ranges
            .first()
            .is_some_and(|&(_, link_end)| link_end <= start)
        {
            ranges = &ranges[1..];
        }
        if ranges.is_empty() {
            break;
        }
        let (ink, logical) = iter.line_extents();
        // Use one position per visual line across all fallback fonts.
        let below_ink = pixels(ink.y() + ink.height()).ceil() + 1.0;
        let line_bottom = pixels(logical.y() + logical.height()).floor() - 1.0;
        let underline = y + below_ink.min(line_bottom);
        for &(link_start, link_end) in ranges
            .iter()
            .take_while(|&&(link_start, _)| link_start < end)
        {
            let seg_start = start.max(link_start);
            let seg_end = end.min(link_end);
            if seg_start < seg_end {
                let spans = line.x_ranges(seg_start, seg_end);
                for span in spans.chunks_exact(2) {
                    cr.rectangle(
                        x + pixels(span[0]),
                        underline,
                        pixels(span[1] - span[0]),
                        1.0,
                    );
                }
            }
        }
        if !iter.next_line() {
            break;
        }
    }
    let _ = cr.fill();
}

pub fn set_markdown(label: &gtk::Label, markdown: &str) {
    let mut markup = String::new();
    let mut link = false;
    for event in parser(markdown) {
        match event {
            Event::Start(Tag::Heading { .. }) => markup.push_str("<b>"),
            Event::End(TagEnd::Heading(_)) => markup.push_str("</b>\n\n"),
            Event::Start(Tag::CodeBlock(_)) => markup.push_str("<tt>"),
            Event::End(TagEnd::CodeBlock) => markup.push_str("</tt>\n\n"),
            Event::End(TagEnd::Paragraph | TagEnd::TableRow | TagEnd::TableHead) => {
                markup.push_str("\n\n");
            }
            Event::End(TagEnd::TableCell) => markup.push_str("   "),
            Event::Start(Tag::Item) => markup.push_str("• "),
            Event::End(TagEnd::Item) => markup.push('\n'),
            event => inline(&mut markup, event, &mut link),
        }
    }
    label.set_markup(markup.trim_end());
}

fn parser(markdown: &str) -> Parser<'_> {
    Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
    )
}

fn flush_text(
    blocks: &gtk::Box,
    pending: &mut String,
    selectable: &mut Vec<Part>,
    new_label: &impl Fn() -> gtk::Label,
) {
    if !pending.trim().is_empty() {
        let label = new_label();
        label.style_context().add_class("agent-prose");
        let markup = pending.trim();
        if markup.contains("<a href=") || pango::parse_markup(markup, '\0').is_ok() {
            label.set_markup(markup);
        } else {
            label.set_text(markup);
        }
        let part = Part::new(&label, "\n\n");
        blocks.add(&part.widget);
        selectable.push(part);
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
    let mut cell_markup = String::new();
    let mut link = false;
    let mut cells = Vec::new();
    let mut rows = Vec::new();
    let mut end = start;
    let mut in_cell = false;
    for (event, range) in events.by_ref() {
        match event {
            Event::Start(Tag::TableCell) => {
                cell.clear();
                cell_markup.clear();
                in_cell = true;
            }
            Event::End(TagEnd::TableCell) => {
                in_cell = false;
                if row < 100 && col < 20 {
                    let label = markdown_label();
                    label.set_markup(&cell_markup);
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
                    let part = Part::new(&label, separator);
                    grid.attach(&part.widget, col, row, 1, 1);
                    selectable.push(part);
                }
                cells.push(std::mem::take(&mut cell));
                col += 1;
            }
            Event::End(TagEnd::TableRow | TagEnd::TableHead) => {
                rows.push(std::mem::take(&mut cells));
                row += 1;
                col = 0;
            }
            Event::End(TagEnd::Table) => {
                end = range.end;
                break;
            }
            event if in_cell => {
                match &event {
                    Event::Text(value) | Event::Code(value) => cell.push_str(value),
                    Event::SoftBreak | Event::HardBreak => cell.push('\n'),
                    _ => {}
                }
                inline(&mut cell_markup, event, &mut link);
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
    scroll_conversation_at_edges(scroll.upcast_ref());
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

fn scroll_conversation_at_edges(scroll: &gtk::ScrolledWindow) {
    scroll.connect_scroll_event(|scroll, event| {
        let Some(delta) = vertical_delta(event) else {
            return glib::Propagation::Proceed;
        };
        let remaining = if scroll.policy().1 == gtk::PolicyType::Never {
            delta
        } else {
            scroll_vertical(scroll, delta)
        };
        if remaining.abs() > 0.001
            && let Some(timeline) = scroll
                .parent()
                .and_then(|parent| parent.ancestor(gtk::ScrolledWindow::static_type()))
                .and_downcast::<gtk::ScrolledWindow>()
        {
            scroll_vertical(&timeline, remaining);
        }
        glib::Propagation::Stop
    });
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
        let copy = crate::icons::button(crate::icons::Icon::Copy, copy_label, copy_label);
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
            .pixels_above_lines(1)
            .pixels_below_lines(1)
            .build();
        view.style_context().add_class("agent-code-view");
        let buffer = view.buffer().expect("code view buffer");
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Automatic)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .build();
        scroll.add(&view);
        scroll_conversation_at_edges(&scroll);
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

pub fn code_card(
    language: &str,
    code: &str,
    status: Option<&str>,
    quote: &quote::Action,
) -> gtk::Box {
    let card = CodeCard::new(language, "复制代码");
    card.buffer.set_text(&code.replace('\0', "�"));
    card.size_to(code);
    let buffer = card.buffer.clone();
    card.copy.connect_clicked(move |_| {
        if let Some(text) = buffer.text(&buffer.start_iter(), &buffer.end_iter(), true) {
            clipboard().set_text(&text);
        }
    });
    if let Some(view) = card.scroll.child().and_downcast::<gtk::TextView>() {
        quote::bind_text(&view, quote);
    }
    if let Some(status) = status {
        let footer = gtk::Label::new(Some(status));
        footer.set_xalign(1.0);
        footer.style_context().add_class("agent-code-status");
        match status {
            "成功" => footer.style_context().add_class("status-success"),
            "失败" | "已拒绝" => footer.style_context().add_class("status-failed"),
            _ => {}
        }
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

fn load_image(path: &Path, socket: Option<&crate::ssh::Channel>) -> Result<Vec<u8>, String> {
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

pub(crate) fn decode_image(bytes: &[u8]) -> Result<gdk_pixbuf::Pixbuf, String> {
    let kind = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "jpeg"
    } else {
        return Err("图片预览支持 PNG 和 JPEG。".into());
    };
    decode_pixbuf(bytes, kind)
}

pub(crate) fn decode_pixbuf(bytes: &[u8], kind: &str) -> Result<gdk_pixbuf::Pixbuf, String> {
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
    let mut link = false;
    html::push_html(
        &mut formatted,
        parser(markdown).filter_map(|event| match event {
            Event::Html(text) | Event::InlineHtml(text) => Some(Event::Text(text)),
            Event::Start(Tag::Link { ref dest_url, .. }) => {
                link = web_url(dest_url);
                link.then_some(event)
            }
            Event::End(TagEnd::Link) => std::mem::take(&mut link).then_some(event),
            Event::Start(Tag::Image { .. }) | Event::End(TagEnd::Image) => None,
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
    fn rich_clipboard_keeps_web_links_and_filters_other_schemes() {
        let html =
            rich_html("[Docs](https://example.invalid/?x=1&y=2) [Local](file:///tmp/example)");
        assert!(html.contains(r#"<a href="https://example.invalid/?x=1&amp;y=2">Docs</a>"#));
        assert!(html.contains("Local"));
        assert!(!html.contains("file:"));
    }

    #[test]
    fn csv_preserves_commas_quotes_and_line_breaks() {
        let rows = vec![vec!["plain".into(), "a,\"b\"\nc".into()]];
        assert_eq!(table_csv(&rows), "plain,\"a,\"\"b\"\"\nc\"\r\n");
    }
}
