use crate::icons::{self, Icon};
use gtk::prelude::*;
use gtk::{gdk, glib, pango};
use std::cell::RefCell;
use std::rc::Rc;

pub type Action = Rc<dyn Fn(&str)>;

pub struct DraftQuotes {
    pub widget: gtk::ScrolledWindow,
    list: gtk::Box,
    entries: RefCell<Vec<(gtk::Box, String)>>,
}

impl DraftQuotes {
    pub fn new() -> Rc<Self> {
        let widget = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::Automatic)
            .max_content_height(114)
            .propagate_natural_height(true)
            .no_show_all(true)
            .build();
        widget.style_context().add_class("draft-quotes");
        let list = gtk::Box::new(gtk::Orientation::Vertical, 4);
        widget.add(&list);
        list.show_all();
        if let Some(viewport) = widget.child() {
            viewport.show();
        }
        Rc::new(Self {
            widget,
            list,
            entries: RefCell::new(Vec::new()),
        })
    }

    pub fn add(self: &Rc<Self>, text: &str) {
        let text = crate::agent::limited(text.trim_matches(['\n', '\r']), 64 * 1024);
        if text.trim().is_empty() {
            return;
        }
        let card = gtk::Box::new(gtk::Orientation::Horizontal, 7);
        card.style_context().add_class("draft-quote");
        let glyph = gtk::Label::new(Some("“"));
        glyph.style_context().add_class("draft-quote-glyph");
        glyph.set_valign(gtk::Align::Start);
        card.pack_start(&glyph, false, false, 0);
        let excerpt = gtk::Label::new(Some(&text));
        excerpt.set_xalign(0.0);
        excerpt.set_line_wrap(true);
        excerpt.set_line_wrap_mode(pango::WrapMode::WordChar);
        excerpt.set_lines(2);
        excerpt.set_ellipsize(pango::EllipsizeMode::End);
        card.pack_start(&excerpt, true, true, 0);
        let remove = gtk::Button::new();
        remove.style_context().add_class("quiet-button");
        remove.add(&icons::widget(Icon::Close, 13));
        remove.set_valign(gtk::Align::Start);
        remove.set_tooltip_text(Some("移除引用"));
        if let Some(accessible) = remove.accessible() {
            accessible.set_name("移除引用");
        }
        card.pack_end(&remove, false, false, 0);
        let quotes = Rc::downgrade(self);
        let weak_card = card.downgrade();
        remove.connect_clicked(move |_| {
            if let (Some(quotes), Some(card)) = (quotes.upgrade(), weak_card.upgrade()) {
                quotes
                    .entries
                    .borrow_mut()
                    .retain(|(entry, _)| *entry != card);
                quotes.list.remove(&card);
                quotes
                    .widget
                    .set_visible(!quotes.entries.borrow().is_empty());
            }
        });
        self.entries.borrow_mut().push((card.clone(), text));
        self.list.add(&card);
        card.show_all();
        self.widget.show();
    }

    pub fn message(&self, editor: &str) -> (String, usize) {
        let entries = self.entries.borrow();
        let mut message = String::new();
        for (_, quote) in entries.iter() {
            for line in quote.lines() {
                message.push_str("> ");
                message.push_str(line);
                message.push('\n');
            }
            message.push('\n');
        }
        message.push_str(editor);
        (message.trim_end().to_owned(), entries.len())
    }

    pub fn finish_send(&self, count: usize) {
        let mut entries = self.entries.borrow_mut();
        let count = count.min(entries.len());
        for (card, _) in entries.drain(..count) {
            self.list.remove(&card);
        }
        let empty = entries.is_empty();
        drop(entries);
        self.widget.set_visible(!empty);
    }
}

#[derive(Default)]
pub struct Popup(glib::WeakRef<gtk::Popover>);

impl Popup {
    pub fn hide(&self) {
        if let Some(popup) = self.0.upgrade() {
            popup.popdown();
        }
        self.0.set(None);
    }

    pub fn show(&self, widget: &gtk::Widget, root: (f64, f64), text: String, action: Action) {
        self.hide();
        if text.trim().is_empty() || !widget.is_mapped() {
            return;
        }
        let Some(top) = widget.toplevel() else { return };
        let Some(window) = top.window() else { return };
        let (_, x, y) = window.origin();
        let Some((x, y)) = top.translate_coordinates(widget, root.0 as i32 - x, root.1 as i32 - y)
        else {
            return;
        };
        let popup = gtk::Popover::new(Some(widget));
        popup.style_context().add_class("selection-quote");
        popup.set_modal(false);
        popup.set_position(gtk::PositionType::Top);
        popup.set_pointing_to(&gdk::Rectangle::new(x, y - 4, 1, 1));
        let button = gtk::Button::with_label("引用");
        button.set_focus_on_click(false);
        let displayed = popup.downgrade();
        button.connect_clicked(move |_| {
            if let Some(popup) = displayed.upgrade() {
                popup.popdown();
            }
            action(&text);
        });
        popup.connect_closed(|popup| {
            let popup = popup.clone();
            glib::idle_add_local_once(move || {
                popup.hide();
                popup.set_relative_to(gtk::Widget::NONE);
            });
        });
        popup.add(&button);
        button.show();
        self.0.set(Some(&popup));
        popup.popup();
    }
}

pub fn bind_label(label: &gtk::Label, action: &Action) {
    bind(label, action, |label| {
        let (start, end) = label.selection_bounds()?;
        Some(
            label
                .text()
                .chars()
                .skip(start as usize)
                .take((end - start) as usize)
                .collect(),
        )
    });
}

pub fn bind_text(view: &gtk::TextView, action: &Action) {
    bind(view, action, |view| {
        let buffer = view.buffer()?;
        let (start, end) = buffer.selection_bounds()?;
        buffer.text(&start, &end, true).map(|text| text.to_string())
    });
}

fn bind<W>(widget: &W, action: &Action, selected: impl Fn(&W) -> Option<String> + 'static)
where
    W: IsA<gtk::Widget> + Clone + 'static,
{
    let popup = Rc::new(Popup::default());
    let clear = popup.clone();
    widget.connect_button_press_event(move |_, _| {
        clear.hide();
        glib::Propagation::Proceed
    });
    let clear = popup.clone();
    widget.connect_scroll_event(move |_, _| {
        clear.hide();
        glib::Propagation::Proceed
    });
    let clear = popup.clone();
    widget.connect_unmap(move |_| clear.hide());
    let action = action.clone();
    let selected = Rc::new(selected);
    widget.connect_button_release_event(move |widget, event| {
        if event.button() == 1 {
            let widget = widget.downgrade();
            let root = event.root();
            let (action, selected, popup) = (action.clone(), selected.clone(), popup.clone());
            glib::idle_add_local_once(move || {
                if let Some(widget) = widget.upgrade()
                    && let Some(text) = selected(&widget)
                {
                    popup.show(widget.as_ref(), root, text, action);
                }
            });
        }
        glib::Propagation::Proceed
    });
}
