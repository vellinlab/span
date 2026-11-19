use crate::agent_render::clipboard;
use crate::quote;
use gtk::atk::prelude::{HyperlinkExt, HypertextExt};
use gtk::prelude::*;
use gtk::{gdk, glib, pango};
use std::cell::{Cell, OnceCell, RefCell};

pub fn vertical_delta(event: &gdk::EventScroll) -> Option<f64> {
    if event.state().contains(gdk::ModifierType::SHIFT_MASK) {
        return None;
    }
    let delta = match event.direction() {
        gdk::ScrollDirection::Up => -1.0,
        gdk::ScrollDirection::Down => 1.0,
        gdk::ScrollDirection::Smooth => {
            let (x, y) = event.delta();
            if y.abs() < x.abs() {
                return None;
            }
            y
        }
        _ => return None,
    };
    (delta.is_finite() && delta != 0.0).then_some(delta)
}

pub fn scroll_vertical(scroll: &gtk::ScrolledWindow, delta: f64) -> f64 {
    let adjustment = scroll.vadjustment();
    let lower = adjustment.lower();
    let upper = (adjustment.upper() - adjustment.page_size()).max(lower);
    let step = adjustment.page_size().powf(2.0 / 3.0).max(1.0);
    let previous = adjustment.value();
    let next = (previous + step * delta).clamp(lower, upper);
    adjustment.set_value(next);
    let remaining = delta - (next - previous) / step;
    if delta < 0.0 && next == lower {
        scroll.emit_by_name::<()>("edge-overshot", &[&gtk::PositionType::Top]);
    }
    remaining
}

pub struct Part {
    pub widget: gtk::EventBox,
    label: gtk::Label,
    separator: &'static str,
}

impl Part {
    pub fn new(label: &gtk::Label, separator: &'static str) -> Self {
        label.set_selectable(false);
        let widget = gtk::EventBox::new();
        widget.set_visible_window(false);
        widget.set_above_child(true);
        widget.add(label);
        Self {
            widget,
            label: label.clone(),
            separator,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Position {
    part: usize,
    byte: usize,
}

type Range = (Position, Position);

#[derive(Clone, Copy)]
struct Drag {
    start: Position,
    root: (f64, f64),
    link_byte: Option<i32>,
    selecting: bool,
}

impl Drag {
    fn moved(self, widget: &gtk::EventBox, root: (f64, f64)) -> bool {
        widget.drag_check_threshold(
            self.root.0 as i32,
            self.root.1 as i32,
            root.0 as i32,
            root.1 as i32,
        )
    }
}

glib::wrapper! {
    pub struct TextSelection(ObjectSubclass<imp::TextSelection>)
        @extends gtk::EventBox, gtk::Bin, gtk::Container, gtk::Widget,
        @implements gtk::Buildable;
}

mod imp {
    use super::*;
    use gtk::subclass::prelude::*;

    #[derive(Default)]
    pub struct TextSelection {
        pub(super) parts: OnceCell<Vec<Part>>,
        pub(super) drag: Cell<Option<Drag>>,
        pub(super) grab: RefCell<glib::WeakRef<gtk::EventBox>>,
        pub(super) range: Cell<Option<Range>>,
        pub(super) quote: OnceCell<quote::Action>,
        pub(super) popup: quote::Popup,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for TextSelection {
        const NAME: &'static str = "SpanTextSelection";
        type Type = super::TextSelection;
        type ParentType = gtk::EventBox;
    }

    impl ObjectImpl for TextSelection {}
    impl WidgetImpl for TextSelection {}
    impl ContainerImpl for TextSelection {}
    impl BinImpl for TextSelection {}
    impl EventBoxImpl for TextSelection {}
}

use gtk::subclass::prelude::ObjectSubclassIsExt;

impl TextSelection {
    pub fn new(child: &gtk::Box, parts: Vec<Part>, quote: &quote::Action) -> Self {
        let view: Self = glib::Object::new();
        assert!(view.imp().parts.set(parts).is_ok());
        assert!(view.imp().quote.set(quote.clone()).is_ok());
        view.set_visible_window(false);
        view.set_can_focus(!view.parts().is_empty());
        view.add(child);
        for part in view.parts() {
            view.bind_pointer(&part.widget);
        }
        view.connect_key_press_event(|view, event| {
            if event.state().contains(gdk::ModifierType::CONTROL_MASK)
                && event.keyval().to_lower() == gdk::keys::constants::c
                && view.copy()
            {
                glib::Propagation::Stop
            } else {
                glib::Propagation::Proceed
            }
        });
        view.connect_focus_out_event(|view, _| {
            view.end_drag();
            glib::Propagation::Proceed
        });
        view.connect_unmap(|view| {
            view.end_drag();
            view.imp().popup.hide();
        });
        view
    }

    fn end_drag(&self) -> Option<Drag> {
        let drag = self.imp().drag.take();
        if let Some(widget) = self
            .imp()
            .grab
            .take()
            .upgrade()
            .filter(|widget| widget.has_grab())
        {
            widget.grab_remove();
        }
        drag
    }

    fn bind_pointer(&self, widget: &gtk::EventBox) {
        widget.add_events(gdk::EventMask::SCROLL_MASK | gdk::EventMask::SMOOTH_SCROLL_MASK);
        let view = self.downgrade();
        widget.connect_button_press_event(move |widget, event| {
            let Some(view) = view.upgrade() else {
                return glib::Propagation::Proceed;
            };
            if event.button() != 1 {
                return glib::Propagation::Proceed;
            }
            view.imp().popup.hide();
            let Some((start, link_byte)) = view.hit(event.root(), false) else {
                return glib::Propagation::Proceed;
            };
            // GTK's viewport scrolls to reveal the focused widget. The pointer
            // is already over the text, and moving the page changes the drag target.
            let scroll = view
                .ancestor(gtk::ScrolledWindow::static_type())
                .and_downcast::<gtk::ScrolledWindow>();
            let position = scroll.as_ref().map(|scroll| scroll.vadjustment().value());
            view.grab_focus();
            if let Some((scroll, position)) = scroll.zip(position) {
                scroll.vadjustment().set_value(position);
            }
            view.change_range(None);
            view.imp().drag.set(Some(Drag {
                start,
                root: event.root(),
                link_byte,
                selecting: false,
            }));
            view.imp().grab.replace(widget.downgrade());
            widget.grab_add();
            glib::Propagation::Stop
        });
        let view = self.downgrade();
        widget.connect_motion_notify_event(move |widget, event| {
            let Some(view) = view.upgrade() else {
                return glib::Propagation::Proceed;
            };
            let Some(drag) = view.imp().drag.get() else {
                return glib::Propagation::Proceed;
            };
            if !event.state().contains(gdk::ModifierType::BUTTON1_MASK) {
                view.end_drag();
                return glib::Propagation::Proceed;
            }
            if drag.selecting || drag.moved(widget, event.root()) {
                view.extend_to(event.root());
            }
            glib::Propagation::Stop
        });
        let view = self.downgrade();
        widget.connect_button_release_event(move |widget, event| {
            let Some(view) = view.upgrade() else {
                return glib::Propagation::Proceed;
            };
            let Some(drag) = view.imp().drag.get().filter(|_| event.button() == 1) else {
                return glib::Propagation::Proceed;
            };
            let root = event.root();
            if drag.selecting || drag.moved(widget, root) {
                view.extend_to(root);
            }
            let Some(drag) = view.end_drag() else {
                return glib::Propagation::Proceed;
            };
            if let Some(text) = view.selected_text() {
                gtk::Clipboard::get(&gdk::SELECTION_PRIMARY).set_text(&text);
                if let Some(action) = view.imp().quote.get() {
                    view.imp()
                        .popup
                        .show(view.upcast_ref(), root, text, action.clone());
                }
            } else if !drag.selecting
                && let Some(start) = drag.link_byte
                && let Some((position, Some(end))) = view.hit(root, false)
                && position.part == drag.start.part
            {
                let label = &view.parts()[position.part].label;
                if let Some(uri) = link_at(label, start)
                    .filter(|uri| start == end || link_at(label, end).as_ref() == Some(uri))
                {
                    label.emit_by_name::<bool>("activate-link", &[&uri.as_str()]);
                }
            }
            glib::Propagation::Stop
        });
        let view = self.downgrade();
        widget.connect_grab_broken_event(move |_, _| {
            if let Some(view) = view.upgrade() {
                view.end_drag();
            }
            glib::Propagation::Proceed
        });
        let view = self.downgrade();
        widget.connect_scroll_event(move |_, event| {
            let (Some(view), Some(delta)) = (view.upgrade(), vertical_delta(event)) else {
                return glib::Propagation::Proceed;
            };
            view.imp().popup.hide();
            if view.imp().drag.get().is_some()
                && !event.state().contains(gdk::ModifierType::BUTTON1_MASK)
            {
                view.end_drag();
            }
            if let Some(scroll) = view
                .ancestor(gtk::ScrolledWindow::static_type())
                .and_downcast::<gtk::ScrolledWindow>()
            {
                scroll_vertical(&scroll, delta);
                if view.imp().drag.get().is_some() {
                    view.extend_to(event.root());
                }
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
    }

    pub fn is_selecting(&self) -> bool {
        self.imp().drag.get().is_some() || self.imp().range.get().is_some()
    }

    fn parts(&self) -> &[Part] {
        self.imp()
            .parts
            .get()
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    fn hit(&self, root: (f64, f64), nearest: bool) -> Option<(Position, Option<i32>)> {
        let top = self.toplevel()?;
        let (_, origin_x, origin_y) = top.window()?.origin();
        let (x, y) =
            top.translate_coordinates(self, root.0 as i32 - origin_x, root.1 as i32 - origin_y)?;
        let mut closest = None;
        let mut distance = i32::MAX;
        for (index, part) in self.parts().iter().enumerate() {
            let Some((left, top)) = part.label.translate_coordinates(self, 0, 0) else {
                continue;
            };
            let local_x = x - left;
            let local_y = y - top;
            let width = part.label.allocated_width();
            let height = part.label.allocated_height();
            let dx = (-local_x).max(local_x - width + 1).max(0);
            let dy = (-local_y).max(local_y - height + 1).max(0);
            if dx == 0 && dy == 0 {
                closest = Some((index, local_x, local_y));
                break;
            }
            if nearest && dx + dy < distance {
                distance = dx + dy;
                closest = Some((index, local_x, local_y));
            }
        }
        let (part, x, y) = closest?;
        let label = &self.parts()[part].label;
        let (left, top) = label.layout_offsets();
        // Labels have no GDK window. GTK reports layout offsets in the
        // containing window, while x and y above are relative to the label.
        let allocation = label.allocation();
        let (inside, index, trailing) = label.layout()?.xy_to_index(
            (x + allocation.x() - left).saturating_mul(pango::SCALE),
            (y + allocation.y() - top).saturating_mul(pango::SCALE),
        );
        let text = label.text();
        let index = (index as usize).min(text.len());
        let suffix = text.get(index..)?;
        let byte = index
            + suffix
                .chars()
                .take(trailing.max(0) as usize)
                .map(char::len_utf8)
                .sum::<usize>();
        let link_byte = (inside && !nearest && !suffix.is_empty()).then_some(index as i32);
        Some((Position { part, byte }, link_byte))
    }

    fn extend_to(&self, root: (f64, f64)) {
        if let Some(mut drag) = self.imp().drag.get() {
            drag.selecting = true;
            self.imp().drag.set(Some(drag));
            if let Some((end, _)) = self.hit(root, true) {
                let start = drag.start;
                self.change_range((start != end).then(|| (start.min(end), start.max(end))));
            }
        }
    }

    fn change_range(&self, range: Option<Range>) {
        let old = self.imp().range.replace(range);
        if old == range {
            return;
        }
        for (index, part) in self.parts().iter().enumerate() {
            let before = bounds(old, index);
            let after = bounds(range, index);
            if before == after {
                continue;
            }
            if let Some((start, end)) = after {
                let attributes = pango::AttrList::new();
                let mut highlight = pango::AttrColor::new_background(0x3232, 0x5858, 0x8484);
                highlight.set_start_index(start as u32);
                highlight.set_end_index(end as u32);
                attributes.insert(highlight);
                part.label.set_attributes(Some(&attributes));
            } else {
                part.label.set_attributes(None);
            }
        }
    }

    fn selected_text(&self) -> Option<String> {
        let (start, end) = self.imp().range.get()?;
        let mut text = String::new();
        for index in start.part..=end.part {
            let part = &self.parts()[index];
            let value = part.label.text();
            let (from, to) = bounds(Some((start, end)), index)?;
            if index != start.part {
                text.push_str(part.separator);
            }
            text.push_str(value.get(from..to.min(value.len()))?);
        }
        (!text.is_empty()).then_some(text)
    }

    pub fn copy(&self) -> bool {
        let Some(text) = self.selected_text() else {
            return false;
        };
        clipboard().set_text(&text);
        true
    }
}

fn link_at(label: &gtk::Label, byte: i32) -> Option<glib::GString> {
    let links = label
        .accessible()?
        .dynamic_cast::<gtk::atk::Hypertext>()
        .ok()?;
    // GTK3 forwards this index to GtkLabel's UTF-8 byte ranges.
    let index = links.link_index(byte);
    if index < 0 {
        return None;
    }
    links.link(index)?.uri(0)
}

fn bounds(range: Option<Range>, part: usize) -> Option<(usize, usize)> {
    let (start, end) = range?;
    (start.part..=end.part).contains(&part).then(|| {
        let from = if part == start.part { start.byte } else { 0 };
        let to = if part == end.part {
            end.byte
        } else {
            u32::MAX as usize
        };
        (from, to)
    })
}
