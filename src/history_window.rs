//! Keep distant transcript content and shaped prose out of GTK layout.
use gtk::glib;
use gtk::prelude::*;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

mod prose_slot {
    use super::*;
    use gtk::subclass::prelude::*;

    // The reading column sets the width. Measuring an unwrapped label's
    // preferred width would shape the same prose before measuring its height.
    #[derive(Default)]
    pub struct ProseSlot;

    #[glib::object_subclass]
    impl ObjectSubclass for ProseSlot {
        const NAME: &'static str = "SpanProseSlot";
        type Type = super::ProseSlot;
        type ParentType = gtk::Bin;
    }

    impl ObjectImpl for ProseSlot {}
    impl ContainerImpl for ProseSlot {}
    impl BinImpl for ProseSlot {}

    impl WidgetImpl for ProseSlot {
        fn request_mode(&self) -> gtk::SizeRequestMode {
            gtk::SizeRequestMode::HeightForWidth
        }

        fn preferred_width(&self) -> (i32, i32) {
            (1, 1)
        }

        fn preferred_width_for_height(&self, _: i32) -> (i32, i32) {
            self.preferred_width()
        }

        fn preferred_height(&self) -> (i32, i32) {
            let height = self.obj().allocated_height();
            (height, height)
        }

        fn preferred_height_for_width(&self, width: i32) -> (i32, i32) {
            self.obj()
                .child()
                .filter(|child| child.is_visible())
                .map_or((0, 0), |child| child.preferred_height_for_width(width))
        }

        fn preferred_height_and_baseline_for_width(&self, width: i32) -> (i32, i32, i32, i32) {
            let (minimum, natural) = if width > 0 {
                self.preferred_height_for_width(width)
            } else {
                self.preferred_height()
            };
            (minimum, natural, -1, -1)
        }

        fn size_allocate(&self, allocation: &gtk::Allocation) {
            let slot = self.obj();
            slot.set_allocation(allocation);
            if let Some(child) = slot.child().filter(|child| child.is_visible()) {
                child.size_allocate(allocation);
                slot.set_clip(&child.clip());
            } else {
                slot.set_clip(allocation);
            }
        }
    }
}

glib::wrapper! {
    pub struct ProseSlot(ObjectSubclass<prose_slot::ProseSlot>)
        @extends gtk::Bin, gtk::Container, gtk::Widget,
        @implements gtk::Buildable;
}

const REPLY_EVICTION_DELAY: Duration = Duration::from_millis(900);

struct Block {
    slot: glib::WeakRef<gtk::Widget>,
    content: glib::WeakRef<gtk::Widget>,
    texts: Vec<DeferredText>,
    visible: Cell<bool>,
}

struct BlockLayout {
    index: usize,
    top: i32,
    height: i32,
}

pub struct DeferredText {
    label: glib::WeakRef<gtk::Label>,
    source: Rc<str>,
    uses_markup: bool,
    loaded: Cell<bool>,
}

impl DeferredText {
    pub fn new(label: &gtk::Label, source: Rc<str>, uses_markup: bool) -> Self {
        label.show();
        Self {
            label: label.downgrade(),
            source,
            uses_markup,
            loaded: Cell::new(false),
        }
    }

    pub fn prepare(&self) {
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
                slot: slot.upcast_ref::<gtk::Widget>().downgrade(),
                content: content.upcast_ref::<gtk::Widget>().downgrade(),
                texts: Vec::new(),
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
        let lines = wrapped_lines(plain, (self.reading_width() / 8) as usize);
        let height = lines.saturating_mul(21).clamp(21, 48_000) as i32;
        let slot = glib::Object::new::<ProseSlot>();
        slot.set_height_request(height);
        self.register_deferred(
            parent,
            &slot,
            label,
            vec![DeferredText::new(label, source, uses_markup)],
        );
    }

    pub fn reading_width(&self) -> i32 {
        self.history.allocated_width().clamp(360, 800) - 36
    }

    pub fn defer_content(
        self: &Rc<Self>,
        parent: &gtk::Box,
        content: &impl IsA<gtk::Widget>,
        min_width: i32,
        height: i32,
        texts: Vec<DeferredText>,
    ) {
        let slot = gtk::Box::new(gtk::Orientation::Vertical, 0);
        slot.set_size_request(min_width, height);
        self.register_deferred(parent, &slot, content, texts);
    }

    fn register_deferred(
        self: &Rc<Self>,
        parent: &gtk::Box,
        slot: &impl IsA<gtk::Container>,
        content: &impl IsA<gtk::Widget>,
        texts: Vec<DeferredText>,
    ) {
        content.set_no_show_all(true);
        content.hide();
        slot.add(content);
        let slot = slot.as_ref().upcast_ref::<gtk::Widget>();
        parent.add(slot);
        self.blocks.borrow_mut().push(Block {
            slot: slot.downgrade(),
            content: content.upcast_ref::<gtk::Widget>().downgrade(),
            texts,
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
        let movement = top - self.previous_top.replace(top);
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
        let protected = |slot: &gtk::Widget| {
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
        // Adjustment changes schedule work every third of a viewport. Leave
        // enough content ahead of that trigger in either direction, with a
        // little more ready in the direction of travel.
        let (before, after) = match movement {
            value if value.is_finite() && value < -1.0 => (0.60, 0.40),
            value if value.is_finite() && value > 1.0 => (0.40, 0.60),
            _ => (0.45, 0.45),
        };
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
            let near_top = if block.texts.is_empty() {
                top
            } else {
                visible_top
            };
            let (before, after) = if block.texts.is_empty() {
                (0.85, 0.85)
            } else {
                (before, after)
            };
            let far = bottom < near_top - page * (before + 0.90)
                || y_px > near_top + page * (1.90 + after);
            let near =
                bottom >= near_top - page * before && y_px <= near_top + page * (1.0 + after);
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
                anchor = Some((slot.clone(), y, top));
            }
            if hide && !protected(&slot) {
                if !block.texts.is_empty() && !idle {
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
                for text in &block.texts {
                    text.release();
                }
            } else if restore {
                for text in &block.texts {
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

pub fn wrapped_lines(text: &str, columns: usize) -> usize {
    text.lines()
        .map(|line| {
            let cells: usize = line
                .chars()
                .map(|ch| if ch.is_ascii() { 1 } else { 2 })
                .sum();
            cells.div_ceil(columns).max(1)
        })
        .sum::<usize>()
        .max(1)
}
