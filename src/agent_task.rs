use gtk::prelude::*;
use gtk::{glib, pango};
use std::cell::{Cell, RefCell};
use std::f64::consts::TAU;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct TaskStatus {
    pub widget: gtk::Box,
    message: gtk::Label,
    elapsed: gtk::Label,
    interrupt: gtk::Label,
    clock: Rc<Cell<Option<(Instant, u64)>>>,
    ticker: RefCell<Option<glib::SourceId>>,
}

impl TaskStatus {
    pub fn new() -> Self {
        let widget = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        widget.style_context().add_class("agent-task-status");
        widget.set_no_show_all(true);
        let spinner = task_spinner();
        spinner.set_size_request(13, 13);
        spinner.set_valign(gtk::Align::Center);
        let message = gtk::Label::builder()
            .xalign(0.0)
            .ellipsize(pango::EllipsizeMode::End)
            .build();
        let elapsed = gtk::Label::new(None);
        let interrupt = gtk::Label::new(Some("Esc 中断"));
        interrupt.style_context().add_class("agent-task-key");
        widget.pack_start(&spinner, false, false, 0);
        widget.pack_start(&message, true, true, 0);
        widget.pack_start(&elapsed, false, false, 0);
        widget.pack_start(&interrupt, false, false, 0);
        for child in widget.children() {
            child.show();
        }
        Self {
            widget,
            message,
            elapsed,
            interrupt,
            clock: Rc::new(Cell::new(None)),
            ticker: RefCell::new(None),
        }
    }

    pub fn sync_from_server(&self, timestamp: Option<u64>) {
        if let Some(started) = timestamp.filter(|started| *started > 0) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            self.clock
                .set(Some((Instant::now(), now.saturating_sub(started))));
            update_elapsed(&self.elapsed, &self.clock);
        }
    }

    pub fn update(&self, message: Option<&str>, can_interrupt: bool) {
        let Some(message) = message else {
            self.widget.hide();
            self.clock.set(None);
            self.stop_timer();
            return;
        };
        if self.message.text().as_str() != message {
            self.message.set_text(message);
            self.message.set_tooltip_text(Some(message));
        }
        self.interrupt.set_visible(can_interrupt);
        if self.ticker.borrow().is_none() {
            if self.clock.get().is_none() {
                self.clock.set(Some((Instant::now(), 0)));
            }
            update_elapsed(&self.elapsed, &self.clock);
            let label = self.elapsed.clone();
            let clock = self.clock.clone();
            self.ticker.replace(Some(glib::timeout_add_local(
                Duration::from_secs(1),
                move || {
                    update_elapsed(&label, &clock);
                    glib::ControlFlow::Continue
                },
            )));
        }
        self.widget.show();
    }

    fn stop_timer(&self) {
        if let Some(timer) = self.ticker.take() {
            timer.remove();
        }
    }
}

impl Drop for TaskStatus {
    fn drop(&mut self) {
        self.stop_timer();
    }
}

fn task_spinner() -> gtk::DrawingArea {
    const STEPS: u8 = 12;
    let spinner = gtk::DrawingArea::new();
    spinner.set_has_window(false);
    spinner.style_context().add_class("agent-task-spinner");
    let phase = Rc::new(Cell::new(0_u8));
    let current = phase.clone();
    spinner.connect_draw(move |spinner, cr| {
        let x = f64::from(spinner.allocated_width()) / 2.0;
        let y = f64::from(spinner.allocated_height()) / 2.0;
        let phase = TAU * f64::from(current.get()) / f64::from(STEPS);
        let color = spinner.style_context().color(spinner.state_flags());
        cr.set_line_width(1.6);
        cr.set_line_cap(gtk::cairo::LineCap::Round);
        cr.set_source_rgba(
            color.red(),
            color.green(),
            color.blue(),
            color.alpha() * 0.25,
        );
        cr.arc(x, y, 4.5, 0.0, TAU);
        let _ = cr.stroke();
        cr.set_source_rgba(color.red(), color.green(), color.blue(), color.alpha());
        cr.arc(x, y, 4.5, phase, phase + TAU / 3.0);
        let _ = cr.stroke();
        glib::Propagation::Stop
    });

    // A small waiting indicator can run below the display refresh rate.
    // Stop the source when its task or session is hidden.
    let timer = Rc::new(RefCell::new(None::<glib::SourceId>));
    let until_unmap = timer.clone();
    spinner.connect_map(move |spinner| {
        if spinner
            .settings()
            .is_some_and(|settings| !settings.is_gtk_enable_animations())
        {
            return;
        }
        let spinner = spinner.downgrade();
        let phase = phase.clone();
        until_unmap.replace(Some(glib::timeout_add_local(
            Duration::from_millis(80),
            move || {
                let Some(spinner) = spinner.upgrade() else {
                    return glib::ControlFlow::Break;
                };
                phase.set((phase.get() + 1) % STEPS);
                spinner.queue_draw();
                glib::ControlFlow::Continue
            },
        )));
    });
    spinner.connect_unmap(move |_| {
        if let Some(timer) = timer.take() {
            timer.remove();
        }
    });
    spinner
}

fn update_elapsed(label: &gtk::Label, clock: &Cell<Option<(Instant, u64)>>) {
    if let Some((start, already_elapsed)) = clock.get() {
        let seconds = already_elapsed.saturating_add(start.elapsed().as_secs());
        let minutes = seconds / 60;
        let text = if minutes < 60 {
            format!("已运行 {minutes}:{:02}", seconds % 60)
        } else {
            format!(
                "已运行 {}:{:02}:{:02}",
                minutes / 60,
                minutes % 60,
                seconds % 60
            )
        };
        label.set_text(&text);
    }
}
