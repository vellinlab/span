use crate::agent::limited;
use crate::agent_activity::FoldedDetail;
use crate::agent_render::{CodeCard, clipboard};
use crate::unified_diff::{self, Kind};
use gtk::glib;
use gtk::prelude::*;
use std::cell::RefCell;
use std::rc::Rc;

pub struct FoldedDiff {
    detail: FoldedDetail,
    body: gtk::Box,
    title: &'static str,
    files: Option<gtk::Label>,
    card: Rc<RefCell<Option<DiffCard>>>,
}

impl FoldedDiff {
    pub fn new(
        row: &gtk::Expander,
        body: &gtk::Box,
        title: &'static str,
        files: Option<&gtk::Label>,
    ) -> Self {
        Self {
            detail: FoldedDetail::new(row),
            body: body.clone(),
            title,
            files: files.cloned(),
            card: Rc::default(),
        }
    }

    pub fn update(&self, row: &gtk::Expander, patch: String) {
        let body = self.body.clone();
        let title = self.title;
        let files = self.files.clone();
        let card = self.card.clone();
        self.detail.update(row, move || {
            let mut card = card.borrow_mut();
            let card = card.get_or_insert_with(|| {
                let card = DiffCard::new(title);
                body.add(card.widget());
                card.widget().show_all();
                if let Some(files) = files {
                    files.set_no_show_all(true);
                    files.hide();
                }
                card
            });
            card.update(&patch);
        });
    }
}

pub struct DiffCard {
    card: CodeCard,
    source: Rc<RefCell<String>>,
    stats: gtk::Label,
    added: gtk::TextTag,
    removed: gtk::TextTag,
    meta: gtk::TextTag,
    number: gtk::TextTag,
}

impl DiffCard {
    pub fn new(title: &str) -> Self {
        let card = CodeCard::new(title, "复制 diff");
        let stats = gtk::Label::new(None);
        stats.style_context().add_class("agent-diff-stats");
        card.header.pack_start(&stats, false, false, 2);
        let source = Rc::new(RefCell::new(String::new()));
        let copy = source.clone();
        card.copy
            .connect_clicked(move |_| clipboard().set_text(&copy.borrow()));
        let added = gtk::TextTag::builder()
            .foreground("#a6e3ba")
            .paragraph_background("#20362e")
            .build();
        let removed = gtk::TextTag::builder()
            .foreground("#f1a5ab")
            .paragraph_background("#3b282f")
            .build();
        let meta = gtk::TextTag::builder().foreground("#9bb9dd").build();
        let number = gtk::TextTag::builder().foreground("#8190a4").build();
        let table = card.buffer.tag_table().expect("diff tag table");
        for tag in [&added, &removed, &meta, &number] {
            table.add(tag);
        }
        Self {
            card,
            source,
            stats,
            added,
            removed,
            meta,
            number,
        }
    }

    pub fn widget(&self) -> &gtk::Box {
        &self.card.panel
    }

    pub fn update(&self, source: &str) {
        let source = limited(source, 256 * 1024);
        if *self.source.borrow() == source {
            return;
        }
        self.card.size_to(&source);
        let buffer = &self.card.buffer;
        let x = self.card.scroll.hadjustment();
        let y = self.card.scroll.vadjustment();
        let (left, top) = (x.value(), y.value());
        buffer.set_text("");
        let mut cursor = buffer.start_iter();
        let (mut additions, mut deletions) = (0, 0);
        for line in unified_diff::lines(&source) {
            let tag = match line.kind {
                Kind::Added => {
                    additions += 1;
                    Some(&self.added)
                }
                Kind::Removed => {
                    deletions += 1;
                    Some(&self.removed)
                }
                Kind::Context => None,
                Kind::Header => Some(&self.meta),
            };
            let start = cursor.offset();
            let old = line.old.map_or_else(String::new, |value| value.to_string());
            let new = line.new.map_or_else(String::new, |value| value.to_string());
            buffer.insert(&mut cursor, &format!("{old:>5} {new:>5}  "));
            buffer.apply_tag(&self.number, &buffer.iter_at_offset(start), &cursor);
            buffer.insert(&mut cursor, line.text);
            if let Some(tag) = tag {
                buffer.apply_tag(tag, &buffer.iter_at_offset(start), &cursor);
            }
        }
        self.stats.set_markup(&format!("<span foreground=\"#a6e3ba\">+{additions}</span>  <span foreground=\"#f1a5ab\">−{deletions}</span>"));
        self.source.replace(source);
        if left > 0.0 || top > 0.0 {
            glib::idle_add_local_once(move || {
                x.set_value(left);
                y.set_value(top);
            });
        }
    }
}
