use crate::quote;
use gtk::prelude::*;
use gtk::{cairo, glib};
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

pub struct SourceText {
    text: String,
    spans: Vec<(i32, i32, (u8, u8, u8))>,
}

impl SourceText {
    pub fn new(path: &Path, text: String) -> Self {
        let spans = highlight(path, &text);
        Self { text, spans }
    }
}

fn highlight(path: &Path, text: &str) -> Vec<(i32, i32, (u8, u8, u8))> {
    static SYNTAX: OnceLock<(SyntaxSet, Theme)> = OnceLock::new();
    let (syntaxes, theme) = SYNTAX.get_or_init(|| {
        let theme = ThemeSet::load_defaults()
            .themes
            .remove("base16-ocean.dark")
            .unwrap_or_default();
        (SyntaxSet::load_defaults_newlines(), theme)
    });
    let Some(language) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| syntaxes.find_syntax_by_extension(name))
        .or_else(|| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .and_then(|ext| syntaxes.find_syntax_by_extension(ext))
        })
        .or_else(|| {
            text.lines()
                .next()
                .and_then(|line| syntaxes.find_syntax_by_first_line(line))
        })
    else {
        return Vec::new();
    };
    let mut highlighter = HighlightLines::new(language, theme);
    let mut spans = Vec::new();
    let mut offset = 0;
    for line in LinesWithEndings::from(text) {
        // Keep previews responsive on generated files with exceptionally long lines.
        if line.len() > 8192 || spans.len() > 16_000 {
            break;
        }
        let Ok(parts) = highlighter.highlight_line(line, syntaxes) else {
            break;
        };
        for (style, part) in parts {
            let end = offset + part.chars().count() as i32;
            if !part.trim().is_empty() && Some(style.foreground) != theme.settings.foreground {
                let color = style.foreground;
                spans.push((offset, end, (color.r, color.g, color.b)));
            }
            offset = end;
        }
    }
    spans
}

pub fn view(scroll: &gtk::ScrolledWindow, source: SourceText, quote: &quote::Action) -> gtk::Box {
    let view = gtk::TextView::builder()
        .editable(false)
        .cursor_visible(false)
        .monospace(true)
        .wrap_mode(gtk::WrapMode::None)
        .left_margin(12)
        .right_margin(12)
        .top_margin(10)
        .bottom_margin(10)
        .build();
    view.style_context().add_class("agent-code-view");
    if let Some(accessible) = view.accessible() {
        accessible.set_name("文件内容");
    }
    let buffer = view.buffer().expect("GTK text view has a buffer");
    buffer.set_text(&source.text);
    let mut tags = HashMap::new();
    for (start, end, color) in source.spans {
        let tag = tags.entry(color).or_insert_with(|| {
            let (r, g, b) = color;
            let tag = gtk::TextTag::builder()
                .foreground(format!("#{r:02x}{g:02x}{b:02x}"))
                .build();
            if let Some(table) = buffer.tag_table() {
                table.add(&tag);
            }
            tag
        });
        buffer.apply_tag(
            tag,
            &buffer.iter_at_offset(start),
            &buffer.iter_at_offset(end),
        );
    }
    quote::bind_text(&view, quote);

    let gutter = gtk::DrawingArea::new();
    gutter.style_context().add_class("source-gutter");
    if let Some(accessible) = gutter.accessible() {
        accessible.set_name("行号");
    }
    let digits = buffer.line_count().to_string();
    let layout = view.create_pango_layout(Some(&digits));
    gutter.set_width_request(layout.pixel_size().0 + 18);
    let weak_view = view.downgrade();
    gutter.connect_draw(move |gutter, cr| {
        if let Some(view) = weak_view.upgrade() {
            draw_numbers(gutter, cr, &view);
        }
        glib::Propagation::Stop
    });
    let redraw = gutter.downgrade();
    scroll.vadjustment().connect_value_changed(move |_| {
        if let Some(gutter) = redraw.upgrade() {
            gutter.queue_draw();
        }
    });

    scroll.add(&view);
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    row.style_context().add_class("source-preview");
    row.pack_start(&gutter, false, false, 0);
    row.pack_start(scroll, true, true, 0);
    row
}

fn draw_numbers(gutter: &gtk::DrawingArea, cr: &cairo::Context, view: &gtk::TextView) {
    let style = gutter.style_context();
    let (width, height) = (
        f64::from(gutter.allocated_width()),
        f64::from(gutter.allocated_height()),
    );
    gtk::render_background(&style, cr, 0.0, 0.0, width, height);
    gtk::render_frame(&style, cr, 0.0, 0.0, width, height);
    let color = style.color(gutter.state_flags());
    cr.set_source_rgba(color.red(), color.green(), color.blue(), color.alpha());
    let visible = view.visible_rect();
    cr.rectangle(0.0, 0.0, width, f64::from(visible.height()));
    cr.clip();
    let (mut line, _) = view.line_at_y(visible.y());
    let layout = view.create_pango_layout(None);
    loop {
        let (top, line_height) = view.line_yrange(&line);
        let (_, y) = view.buffer_to_window_coords(gtk::TextWindowType::Text, 0, top);
        if y >= visible.height() {
            break;
        }
        layout.set_text(&(line.line() + 1).to_string());
        let (text_width, text_height) = layout.pixel_size();
        cr.move_to(
            width - f64::from(text_width) - 9.0,
            f64::from(y + (line_height - text_height) / 2),
        );
        pangocairo::functions::show_layout(cr, &layout);
        if !line.forward_line() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_preview_marks_tokens_at_character_offsets() {
        let text = "# 例子\nimport os\nname = \"Span\"\n";
        let spans = highlight(Path::new("main.py"), text);
        let (start, end, keyword) = spans.iter().find(|(start, _, _)| *start == 5).unwrap();
        assert_eq!((*start, *end), (5, 11));
        assert!(
            spans
                .iter()
                .any(|(start, _, color)| *start > 11 && color != keyword)
        );
        assert!(highlight(Path::new("unknown.span-fixture"), text).is_empty());
    }
}
