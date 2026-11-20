//! Keep the height of distant transcript blocks but exclude their children from GTK layout.
use gtk::glib;
use gtk::prelude::*;
use gtk::subclass::prelude::ObjectSubclassIsExt;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

// X11 can deliver many wheel packets before GTK presents the next frame.
// Move immediately on an isolated tick, then accumulate the remaining motion
// in logical coordinates without moving all the native child windows per packet.
glib::wrapper! {
    pub struct HistoryScroll(ObjectSubclass<imp::HistoryScroll>)
        @extends gtk::ScrolledWindow, gtk::Bin, gtk::Container, gtk::Widget,
        @implements gtk::Buildable;
}

mod imp {
    use super::*;
    use gtk::subclass::prelude::*;

    #[derive(Default)]
    pub struct HistoryScroll {
        pub(super) pending: Cell<Option<(f64, f64)>>,
        pub(super) ticking: Cell<bool>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for HistoryScroll {
        const NAME: &'static str = "SpanHistoryScroll";
        type Type = super::HistoryScroll;
        type ParentType = gtk::ScrolledWindow;
    }

    impl ObjectImpl for HistoryScroll {}
    impl WidgetImpl for HistoryScroll {
        fn unmap(&self) {
            self.pending.set(None);
            self.parent_unmap();
        }
    }
    impl ContainerImpl for HistoryScroll {}
    impl BinImpl for HistoryScroll {}
    impl ScrolledWindowImpl for HistoryScroll {}
}

impl HistoryScroll {
    pub fn wheel_position(&self, actual: f64) -> f64 {
        self.imp()
            .pending
            .get()
            .filter(|(old, _)| *old == actual)
            .map_or(actual, |(_, target)| target)
    }

    pub fn apply_wheel(&self, adjustment: &gtk::Adjustment, target: f64, edge: bool) {
        let state = self.imp();
        if !state.ticking.replace(true) {
            adjustment.set_value(target);
            self.add_tick_callback(|scroll, _| {
                let state = scroll.imp();
                state.ticking.set(false);
                let adjustment = scroll.vadjustment();
                if let Some((old, target)) = state.pending.take()
                    && old == adjustment.value()
                {
                    adjustment.set_value(target);
                }
                glib::ControlFlow::Break
            });
        } else if edge || gtk::grab_get_current().is_some() {
            // Selection hit testing and history prefetch need the new position now.
            state.pending.set(None);
            adjustment.set_value(target);
        } else {
            state.pending.set(Some((adjustment.value(), target)));
        }
    }
}

struct Block {
    slot: gtk::Box,
    content: gtk::Box,
}

pub struct HistoryWindow {
    history: gtk::Box,
    scroll: gtk::ScrolledWindow,
    blocks: RefCell<Vec<Block>>,
    scheduled: Cell<bool>,
    previous_top: Cell<f64>,
    anchor: RefCell<Option<(gtk::Widget, i32, f64)>>,
}

impl HistoryWindow {
    pub fn new(history: &gtk::Box, scroll: &gtk::ScrolledWindow) -> Rc<Self> {
        let window = Rc::new(Self {
            history: history.clone(),
            scroll: scroll.clone(),
            blocks: RefCell::new(Vec::new()),
            scheduled: Cell::new(false),
            previous_top: Cell::new(f64::NEG_INFINITY),
            anchor: RefCell::new(None),
        });
        let weak = Rc::downgrade(&window);
        scroll.vadjustment().connect_value_changed(move |adj| {
            if let Some(window) = weak.upgrade()
                && (adj.value() - window.previous_top.get()).abs()
                    >= (adj.page_size() / 2.0).max(1.0)
            {
                window.schedule();
            }
        });
        let weak = Rc::downgrade(&window);
        scroll.vadjustment().connect_changed(move |_| {
            if let Some(window) = weak.upgrade() {
                window.schedule();
            }
        });
        window
    }

    pub fn clear(&self) {
        self.blocks.borrow_mut().clear();
        self.anchor.take();
        self.previous_top.set(f64::NEG_INFINITY);
    }

    // Register before the response is shown, so moving children does not remap them.
    pub fn group(self: &Rc<Self>, blocks: &gtk::Box, chunk_size: usize) {
        let children = blocks.children();
        if children.is_empty() {
            return;
        }
        for chunk in children.chunks(chunk_size) {
            let content = gtk::Box::new(gtk::Orientation::Vertical, blocks.spacing());
            for child in chunk {
                blocks.remove(child);
                content.add(child);
            }
            let slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
            slot.add(&content);
            blocks.add(&slot);
            self.blocks.borrow_mut().push(Block { slot, content });
        }
        self.schedule();
    }

    fn schedule(self: &Rc<Self>) {
        if self.scheduled.replace(true) {
            return;
        }
        let weak = Rc::downgrade(self);
        self.scroll.add_tick_callback(move |_, _| {
            if let Some(window) = weak.upgrade() {
                window.scheduled.set(false);
                window.update();
            }
            glib::ControlFlow::Break
        });
    }

    fn update(self: &Rc<Self>) {
        let adj = self.scroll.vadjustment();
        if let Some((widget, old_y, old_top)) = self.anchor.take()
            && (adj.value() - old_top).abs() <= 1.0
            && let Some((_, y)) = widget.translate_coordinates(&self.history, 0, 0)
        {
            adj.set_value(old_top + f64::from(y - old_y));
        }
        let top = adj.value();
        self.previous_top.set(top);
        let page = adj.page_size();
        if page < 2.0 {
            return;
        }
        let focused = self
            .scroll
            .toplevel()
            .and_downcast::<gtk::Window>()
            .and_then(|w| w.focused_widget());
        let grab = gtk::grab_get_current();
        // Keep additional screens ready in both directions. A wider eviction band avoids
        // repeated map/unmap operations when scrolling back across a boundary.
        let mut anchor = None;
        let mut anchor_height = i32::MAX;
        let mut changed_above = false;
        let mut restored = false;
        for block in self.blocks.borrow().iter() {
            let height = block.slot.allocated_height();
            if height < 2 || !block.slot.is_mapped() {
                continue;
            }
            let Some((_, y)) = block.slot.translate_coordinates(&self.history, 0, 0) else {
                continue;
            };
            let bottom = f64::from(y) + f64::from(height);
            if f64::from(y) <= top && top < bottom && height < anchor_height {
                anchor_height = height;
                anchor = Some((block.slot.clone().upcast(), y, top));
            }
            if block.content.is_visible() {
                if (bottom < top - page * 3.0 || f64::from(y) > top + page * 4.0)
                    && !focused
                        .iter()
                        .chain(grab.iter())
                        .any(|widget| widget.is_ancestor(&block.slot))
                {
                    block.slot.set_height_request(height);
                    block.content.set_no_show_all(true);
                    block.content.hide();
                }
            } else if bottom >= top - page * 2.0 && f64::from(y) <= top + page * 3.0 {
                block.content.set_no_show_all(false);
                block.content.show();
                block.slot.set_height_request(-1);
                changed_above |= bottom <= top;
                restored = true;
            }
        }
        if changed_above {
            self.anchor.replace(anchor);
        }
        if restored {
            // Newly mapped replies can contain windowed table rows.
            self.schedule();
        }
    }
}
