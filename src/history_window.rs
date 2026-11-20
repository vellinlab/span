//! Keep distant transcript content and shaped prose out of GTK layout.
use gtk::glib;
use gtk::prelude::*;
use gtk::subclass::prelude::ObjectSubclassIsExt;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

const REPLY_EVICTION_DELAY: Duration = Duration::from_millis(900);
const WHEEL_GESTURE_GAP: Duration = Duration::from_millis(40);

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
        pub(super) last_input: Cell<Option<Instant>>,
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
            self.last_input.set(None);
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
        let now = Instant::now();
        let first = state
            .last_input
            .replace(Some(now))
            .is_none_or(|last| now.duration_since(last) >= WHEEL_GESTURE_GAP);
        let actual = adjustment.value();
        if actual == target || first || edge || gtk::grab_get_current().is_some() {
            // Start immediately and keep text selection and history prefetch in sync.
            state.pending.set(None);
            if actual != target {
                adjustment.set_value(target);
            }
            return;
        }
        state.pending.set(Some((actual, target)));
        if state.ticking.replace(true) {
            return;
        }
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
    }
}

struct Block {
    slot: glib::WeakRef<gtk::Box>,
    content: glib::WeakRef<gtk::Widget>,
    text: Option<DeferredText>,
    visible: Cell<bool>,
}

struct BlockLayout {
    index: usize,
    top: i32,
    height: i32,
}

struct DeferredText {
    label: glib::WeakRef<gtk::Label>,
    source: Rc<str>,
    uses_markup: bool,
    loaded: Cell<bool>,
}

impl DeferredText {
    fn prepare(&self) {
        if !self.loaded.replace(true)
            && let Some(label) = self.label.upgrade()
        {
            if self.uses_markup {
                label.set_markup(&self.source);
            } else {
                label.set_text(&self.source);
            }
        }
    }

    fn release(&self) {
        if self.loaded.replace(false)
            && let Some(label) = self.label.upgrade()
        {
            label.set_text("");
        }
    }
}

pub struct HistoryWindow {
    history: gtk::Box,
    scroll: gtk::ScrolledWindow,
    blocks: RefCell<Vec<Block>>,
    layout: RefCell<Vec<BlockLayout>>,
    layout_dirty: Cell<bool>,
    follow_tail: Rc<Cell<bool>>,
    scheduled: Cell<bool>,
    previous_top: Cell<f64>,
    last_motion: Cell<Instant>,
    cleanup_scheduled: Cell<bool>,
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
            layout: RefCell::new(Vec::new()),
            layout_dirty: Cell::new(true),
            follow_tail,
            scheduled: Cell::new(false),
            previous_top: Cell::new(f64::NEG_INFINITY),
            last_motion: Cell::new(Instant::now()),
            cleanup_scheduled: Cell::new(false),
            anchor: RefCell::new(None),
        });
        let weak = Rc::downgrade(&window);
        scroll.vadjustment().connect_value_changed(move |adj| {
            if let Some(window) = weak.upgrade() {
                window.last_motion.set(Instant::now());
                if (adj.value() - window.previous_top.get()).abs()
                    >= (adj.page_size() / 3.0).max(1.0)
                {
                    window.schedule();
                }
            }
        });
        let weak = Rc::downgrade(&window);
        history.connect_size_allocate(move |_, _| {
            if let Some(window) = weak.upgrade() {
                window.invalidate_layout();
            }
        });
        let weak = Rc::downgrade(&window);
        scroll.connect_map(move |_| {
            if let Some(window) = weak.upgrade() {
                window.invalidate_layout();
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
        self.layout.borrow_mut().clear();
        self.layout_dirty.set(true);
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
                content: content.upcast_ref::<gtk::Widget>().downgrade(),
                text: None,
                visible: Cell::new(true),
            });
        }
        self.invalidate_layout();
    }

    pub fn defer_prose(
        self: &Rc<Self>,
        parent: &gtk::Box,
        label: &gtk::Label,
        source: Rc<str>,
        plain: &str,
        uses_markup: bool,
    ) {
        // The estimate keeps an unvisited block in the scroll range. Once
        // visited, its most recently allocated height takes over.
        let width = self.history.allocated_width().clamp(360, 800) - 36;
        let columns = (width / 8) as usize;
        let lines: usize = plain
            .lines()
            .map(|line| {
                let cells: usize = line
                    .chars()
                    .map(|ch| if ch.is_ascii() { 1 } else { 2 })
                    .sum();
                cells.div_ceil(columns).max(1)
            })
            .sum();
        let slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        slot.set_height_request(lines.saturating_mul(21).clamp(21, 48_000) as i32);
        label.set_no_show_all(true);
        slot.add(label);
        parent.add(&slot);
        self.blocks.borrow_mut().push(Block {
            slot: slot.downgrade(),
            content: label.upcast_ref::<gtk::Widget>().downgrade(),
            text: Some(DeferredText {
                label: label.downgrade(),
                source,
                uses_markup,
                loaded: Cell::new(false),
            }),
            visible: Cell::new(false),
        });
        self.invalidate_layout();
    }

    fn invalidate_layout(self: &Rc<Self>) {
        self.layout_dirty.set(true);
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

    fn schedule_cleanup(self: &Rc<Self>) {
        if self.cleanup_scheduled.replace(true) {
            return;
        }
        let weak = Rc::downgrade(self);
        glib::timeout_add_local(REPLY_EVICTION_DELAY, move || {
            let Some(window) = weak.upgrade() else {
                return glib::ControlFlow::Break;
            };
            if window.last_motion.get().elapsed() < REPLY_EVICTION_DELAY {
                return glib::ControlFlow::Continue;
            }
            window.cleanup_scheduled.set(false);
            window.schedule();
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
        let idle = self.last_motion.get().elapsed() >= REPLY_EVICTION_DELAY;
        // Keep just over a screen ready in either direction, with hysteresis
        // so nearby content stays mapped when the user changes direction.
        let mut anchor = None;
        let mut anchor_height = i32::MAX;
        let mut changed_above = false;
        let mut restored = false;
        let mut shaped = false;
        let blocks = self.blocks.borrow();
        if self.layout_dirty.replace(false) {
            self.cache_layout(&blocks);
        }
        let mut hidden = false;
        for &BlockLayout {
            index,
            top: y,
            height,
        } in self.layout.borrow().iter()
        {
            let block = &blocks[index];
            let y_px = f64::from(y);
            let bottom = y_px + f64::from(height);
            let near_top = if block.text.is_some() {
                visible_top
            } else {
                top
            };
            let far = bottom < near_top - page * 1.75 || y_px > near_top + page * 2.75;
            let near = bottom >= near_top - page * 0.85 && y_px <= near_top + page * 1.85;
            let is_anchor = y_px <= top && top < bottom && height < anchor_height;
            let hide = far && block.visible.get();
            let restore = near && !block.visible.get();
            if !hide && !restore && !is_anchor {
                continue;
            }
            let (Some(slot), Some(content)) = (block.slot.upgrade(), block.content.upgrade())
            else {
                continue;
            };
            if !slot.is_mapped() {
                continue;
            }
            if is_anchor {
                anchor_height = height;
                anchor = Some((slot.clone().upcast(), y, top));
            }
            if hide && !protected(&slot) {
                if block.text.is_some() && !idle {
                    // Reversing a wheel gesture must not remap the same GTK
                    // input windows one frame after hiding them.
                    self.schedule_cleanup();
                    continue;
                }
                slot.set_height_request(height);
                content.set_no_show_all(true);
                content.hide();
                block.visible.set(false);
                hidden = true;
                if let Some(text) = &block.text {
                    text.release();
                }
            } else if restore {
                if let Some(text) = &block.text {
                    shaped |= !text.loaded.get();
                    text.prepare();
                }
                content.set_no_show_all(false);
                content.show();
                block.visible.set(true);
                slot.set_height_request(-1);
                changed_above |= bottom <= top;
                restored = true;
            }
        }
        if changed_above && self.anchor.borrow().is_none() {
            self.anchor.replace(anchor);
        }
        if shaped && self.follow_tail.get() {
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
        if restored || hidden {
            // A restored parent may reveal nested table rows. Invalidate their
            // geometry even when the adjustment's upper bound is unchanged.
            self.invalidate_layout();
        }
    }

    fn cache_layout(&self, blocks: &[Block]) {
        let mut layout = self.layout.borrow_mut();
        layout.clear();
        for (index, block) in blocks.iter().enumerate() {
            let Some(slot) = block.slot.upgrade().filter(|slot| slot.is_mapped()) else {
                continue;
            };
            let height = slot.allocated_height();
            if height >= 2
                && let Some((_, top)) = slot.translate_coordinates(&self.history, 0, 0)
            {
                layout.push(BlockLayout { index, top, height });
            }
        }
    }
}
