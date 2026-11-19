use gtk::prelude::*;
use gtk::{gdk, glib};
use std::rc::Rc;

pub type Action = Rc<dyn Fn(&str)>;

pub fn insert(input: &gtk::TextView, text: &str) {
    if let Some(buffer) = input.buffer() {
        let mut quote = String::new();
        if buffer.char_count() != 0 {
            quote.push_str("\n\n");
        }
        for line in crate::agent::limited(text, 64 * 1024).lines() {
            quote.push_str("> ");
            quote.push_str(line);
            quote.push('\n');
        }
        let mut end = buffer.end_iter();
        buffer.insert(&mut end, &quote);
        buffer.place_cursor(&end);
        input.grab_focus();
        if let Some(mark) = buffer.get_insert() {
            input.scroll_to_mark(&mark, 0.0, false, 0.0, 0.0);
        }
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
