//! Keep distant transcript content out of GTK layout and release large saved replies.
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
    slot: glib::WeakRef<gtk::Box>,
    content: glib::WeakRef<gtk::Box>,
}

struct DeferredReply {
    slot: gtk::Box,
    markdown: String,
    build: Box<dyn Fn(&str, &Rc<HistoryWindow>) -> gtk::Widget>,
}

pub struct HistoryWindow {
    history: gtk::Box,
    scroll: gtk::ScrolledWindow,
    blocks: RefCell<Vec<Block>>,
    replies: RefCell<Vec<DeferredReply>>,
    follow_tail: Rc<Cell<bool>>,
    scheduled: Cell<bool>,
    previous_top: Cell<f64>,
    anchor: RefCell<Option<(gtk::Widget, i32, f64)>>,
}

impl HistoryWindow {
    pub fn new(
        history: &gtk::Box,
        scroll: &gtk::ScrolledWindow,
        follow_tail: Rc<Cell<bool>>,
    ) -> Rc<Self> {
        let window = Rc::new(Self {
            history: history.clone(),
            scroll: scroll.clone(),
            blocks: RefCell::new(Vec::new()),
            replies: RefCell::new(Vec::new()),
            follow_tail,
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
        self.replies.borrow_mut().clear();
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
            self.blocks.borrow_mut().push(Block {
                slot: slot.downgrade(),
                content: content.downgrade(),
            });
        }
        self.schedule();
    }

    pub fn defer_reply(
        self: &Rc<Self>,
        slot: &gtk::Box,
        markdown: String,
        build: impl Fn(&str, &Rc<Self>) -> gtk::Widget + 'static,
    ) {
        // Measure the real height on the first visit. Until then, estimate wrapped
        // lines without shaping the whole transcript or creating GTK children.
        let columns = (self.history.allocated_width().clamp(360, 800) as usize / 8).max(1);
        let lines: usize = markdown
            .lines()
            .map(|line| {
                let cells: usize = line
                    .chars()
                    .map(|ch| if ch.is_ascii() { 1 } else { 2 })
                    .sum();
                cells.div_ceil(columns).max(1)
            })
            .sum();
        slot.set_height_request(lines.saturating_mul(20).clamp(120, 48_000) as i32);
        self.replies.borrow_mut().push(DeferredReply {
            slot: slot.clone(),
            markdown,
            build: Box::new(build),
        });
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
        let protected = |slot: &gtk::Box| {
            focused
                .iter()
                .chain(grab.iter())
                .any(|widget| widget.is_ancestor(slot))
        };
        let visible_top = if self.follow_tail.get() {
            (adj.upper() - page).max(top)
        } else {
            top
        };
        let mut reply_anchor = None;
        let mut materialized = false;
        for reply in self.replies.borrow().iter() {
            let slot = &reply.slot;
            let Some((_, y)) = slot.translate_coordinates(&self.history, 0, 0) else {
                continue;
            };
            let height = slot.allocated_height();
            if height < 2 || !slot.is_mapped() {
                continue;
            }
            let start = f64::from(y);
            let end = start + f64::from(height);
            if let Some(child) = slot.children().into_iter().next() {
                if (end < visible_top - page * 1.5 || start > visible_top + page * 2.5)
                    && !protected(slot)
                {
                    slot.set_height_request(height);
                    slot.remove(&child);
                }
            } else if end >= visible_top - page * 0.5 && start <= visible_top + page * 1.5 {
                if start < visible_top && !self.follow_tail.get() && reply_anchor.is_none() {
                    // Preserve the first on-screen row when an estimate above it
                    // changes; the row itself may be an ordinary eager widget.
                    reply_anchor = self.history.children().into_iter().find_map(|widget| {
                        let (_, row) = widget.translate_coordinates(&self.history, 0, 0)?;
                        (f64::from(row) >= top).then_some((widget, row, top))
                    });
                }
                let child = (reply.build)(&reply.markdown, self);
                slot.add(&child);
                child.show_all();
                slot.set_height_request(-1);
                materialized = true;
            }
        }
        if let Some(anchor) = reply_anchor {
            self.anchor.replace(Some(anchor));
        }
        self.blocks
            .borrow_mut()
            .retain(|block| block.slot.upgrade().is_some());
        // Keep additional screens ready in both directions. A wider eviction band avoids
        // repeated map/unmap operations when scrolling back across a boundary.
        let mut anchor = None;
        let mut anchor_height = i32::MAX;
        let mut changed_above = false;
        let mut restored = false;
        for block in self.blocks.borrow().iter() {
            let (Some(slot), Some(content)) = (block.slot.upgrade(), block.content.upgrade())
            else {
                continue;
            };
            let height = slot.allocated_height();
            if height < 2 || !slot.is_mapped() {
                continue;
            }
            let Some((_, y)) = slot.translate_coordinates(&self.history, 0, 0) else {
                continue;
            };
            let bottom = f64::from(y) + f64::from(height);
            if f64::from(y) <= top && top < bottom && height < anchor_height {
                anchor_height = height;
                anchor = Some((slot.clone().upcast(), y, top));
            }
            if content.is_visible() {
                if (bottom < top - page * 3.0 || f64::from(y) > top + page * 4.0)
                    && !protected(&slot)
                {
                    slot.set_height_request(height);
                    content.set_no_show_all(true);
                    content.hide();
                }
            } else if bottom >= top - page * 2.0 && f64::from(y) <= top + page * 3.0 {
                content.set_no_show_all(false);
                content.show();
                slot.set_height_request(-1);
                changed_above |= bottom <= top;
                restored = true;
            }
        }
        if changed_above && self.anchor.borrow().is_none() {
            self.anchor.replace(anchor);
        }
        if materialized && self.follow_tail.get() {
            let adjustment = adj.downgrade();
            let follow_tail = self.follow_tail.clone();
            self.scroll.add_tick_callback(move |_, _| {
                if follow_tail.get()
                    && let Some(adj) = adjustment.upgrade()
                {
                    adj.set_value(adj.upper() - adj.page_size());
                }
                glib::ControlFlow::Break
            });
        }
        if restored || materialized {
            // Newly mapped replies can contain windowed table rows.
            self.schedule();
        }
    }
}
