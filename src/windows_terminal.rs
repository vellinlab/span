use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty;
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Processor, Rgb};
use futures_channel::mpsc;
use futures_util::StreamExt;
use gtk::glib::subclass::prelude::ObjectSubclassIsExt;
use gtk::prelude::*;
use gtk::{cairo, gdk, gio, glib, pango};
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const FONT: &str = "Cascadia Mono,Consolas,DejaVu Sans Mono,monospace 11";
const PALETTE: [u32; 16] = [
    0x222525, 0xf0838c, 0x83cb9b, 0xe8be79, 0x82aaff, 0xc6a0f6, 0x78cbd7, 0xc3cddb, 0x788789,
    0xff9ca3, 0xa0e4b6, 0xf9d493, 0xa3c1ff, 0xddbcff, 0x9fe3e9, 0xf0f4fb,
];
const BACKGROUND: u32 = 0x151616;

glib::wrapper! {
    pub struct Terminal(ObjectSubclass<imp::Terminal>)
        @extends gtk::DrawingArea, gtk::Widget, @implements gtk::Buildable;
}

type Grid = Arc<FairMutex<Term<Events>>>;
type ExitHandler = Box<dyn Fn(&Terminal, i32)>;

#[derive(Clone)]
struct Events {
    sender: mpsc::UnboundedSender<Event>,
    redraw_pending: Arc<AtomicBool>,
}

impl EventListener for Events {
    fn send_event(&self, event: Event) {
        if matches!(event, Event::Wakeup) && self.redraw_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.sender.unbounded_send(event);
    }
}

#[derive(Clone, Copy)]
struct Size(WindowSize);

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.0.num_lines)
    }

    fn columns(&self) -> usize {
        usize::from(self.0.num_cols)
    }
}

mod imp {
    use super::*;
    use gtk::subclass::prelude::*;

    #[derive(Default)]
    pub struct Terminal {
        pub(super) grid: RefCell<Option<Grid>>,
        pub(super) channel: RefCell<Option<EventLoopSender>>,
        pub(super) scrollback: Cell<usize>,
        pub(super) input: Cell<bool>,
        pub(super) notice: RefCell<String>,
        pub(super) generation: Cell<u64>,
        pub(super) exits: RefCell<Vec<ExitHandler>>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Terminal {
        const NAME: &'static str = "SpanWindowsTerminal";
        type Type = super::Terminal;
        type ParentType = gtk::DrawingArea;
    }

    impl ObjectImpl for Terminal {}
    impl DrawingAreaImpl for Terminal {}
    impl WidgetImpl for Terminal {}
}

impl Terminal {
    pub fn new() -> Self {
        let terminal = glib::Object::builder::<Self>().build();
        terminal.set_can_focus(true);
        terminal.set_hexpand(true);
        terminal.set_vexpand(true);
        terminal.add_events(
            gdk::EventMask::BUTTON_PRESS_MASK
                | gdk::EventMask::BUTTON_MOTION_MASK
                | gdk::EventMask::SCROLL_MASK
                | gdk::EventMask::SMOOTH_SCROLL_MASK,
        );
        terminal.connect_draw(|terminal, cr| {
            terminal.paint(cr);
            glib::Propagation::Stop
        });
        terminal.connect_size_allocate(|terminal, _| terminal.resize());
        terminal.connect_scroll_event(|terminal, event| {
            if let Some(lines) = crate::agent_selection::vertical_delta(event) {
                terminal.scroll(Scroll::Delta(if lines > 0.0 { -3 } else { 3 }));
            }
            glib::Propagation::Stop
        });
        terminal.connect_button_press_event(|terminal, event| {
            if event.button() == 1 {
                terminal.grab_focus();
                terminal.select(event.position(), true);
            }
            glib::Propagation::Proceed
        });
        terminal.connect_motion_notify_event(|terminal, event| {
            if event.state().contains(gdk::ModifierType::BUTTON1_MASK) {
                terminal.select(event.position(), false);
            }
            glib::Propagation::Proceed
        });

        let input = gtk::IMMulticontext::new();
        let weak = terminal.downgrade();
        input.connect_commit(move |_, text| {
            if let Some(terminal) = weak.upgrade() {
                terminal.write(text.as_bytes().to_vec(), true);
            }
        });
        let context = input.clone();
        terminal
            .connect_realize(move |terminal| context.set_client_window(terminal.window().as_ref()));
        let context = input.clone();
        terminal.connect_focus_in_event(move |_, _| {
            context.focus_in();
            glib::Propagation::Proceed
        });
        let context = input.clone();
        terminal.connect_focus_out_event(move |_, _| {
            context.focus_out();
            glib::Propagation::Proceed
        });
        terminal.connect_key_press_event(move |terminal, event| terminal.key(event, &input));
        terminal
    }

    pub fn apply_theme(&self) {}

    pub fn set_scrollback_lines(&self, lines: i64) {
        self.imp().scrollback.set(lines.max(0) as usize);
    }

    pub fn set_input_enabled(&self, enabled: bool) {
        self.imp().input.set(enabled);
    }

    pub fn reset(&self, _: bool, _: bool) {
        self.imp().generation.set(self.imp().generation.get() + 1);
        if let Some(channel) = self.imp().channel.take() {
            let _ = channel.send(Msg::Shutdown);
        }
        self.imp().grid.take();
        self.imp().notice.borrow_mut().clear();
        self.queue_draw();
    }

    pub fn feed(&self, data: &[u8]) {
        if let Some(grid) = self.imp().grid.borrow().as_ref() {
            let mut processor: Processor = Processor::new();
            processor.advance(&mut *grid.lock(), data);
        } else {
            self.imp()
                .notice
                .borrow_mut()
                .push_str(&String::from_utf8_lossy(data));
        }
        self.queue_draw();
    }

    pub fn connect_child_exited(&self, handler: impl Fn(&Self, i32) + 'static) {
        self.imp().exits.borrow_mut().push(Box::new(handler));
    }

    pub fn spawn(
        &self,
        cwd: Option<&str>,
        argv: &[&str],
        env: &[&str],
        cancellable: &gio::Cancellable,
        callback: impl FnOnce(Result<(), String>) + 'static,
    ) {
        let (program, arguments) = argv.split_first().expect("terminal program");
        let size = self.size();
        let options = tty::Options {
            shell: Some(tty::Shell::new(
                (*program).into(),
                arguments.iter().map(|s| (*s).into()).collect(),
            )),
            working_directory: cwd.map(PathBuf::from),
            drain_on_exit: true,
            env: env
                .iter()
                .filter_map(|entry| entry.split_once('='))
                .map(|(k, v)| (k.into(), v.into()))
                .chain([("TERM".into(), "xterm-256color".into())])
                .collect(),
            escape_args: true,
        };
        let pty = match tty::new(&options, size.0, 0) {
            Ok(pty) => pty,
            Err(error) => return callback(Err(error.to_string())),
        };
        let (sender, mut receiver) = mpsc::unbounded();
        let redraw_pending = Arc::new(AtomicBool::new(false));
        let events = Events {
            sender,
            redraw_pending: redraw_pending.clone(),
        };
        let config = Config {
            scrolling_history: self.imp().scrollback.get(),
            ..Config::default()
        };
        let grid = Arc::new(FairMutex::new(Term::new(config, &size, events.clone())));
        let event_loop = match EventLoop::new(grid.clone(), events, pty, true, false) {
            Ok(event_loop) => event_loop,
            Err(error) => return callback(Err(error.to_string())),
        };
        let channel = event_loop.channel();
        self.imp().grid.replace(Some(grid));
        self.imp().channel.replace(Some(channel.clone()));
        drop(event_loop.spawn());
        cancellable.connect_cancelled(move |_| {
            let _ = channel.send(Msg::Shutdown);
        });

        let weak = self.downgrade();
        let generation = self.imp().generation.get();
        glib::MainContext::default().spawn_local(async move {
            let mut status = 1;
            while let Some(event) = receiver.next().await {
                let Some(terminal) = weak
                    .upgrade()
                    .filter(|terminal| terminal.imp().generation.get() == generation)
                else {
                    break;
                };
                match event {
                    Event::Wakeup => {
                        redraw_pending.store(false, Ordering::Release);
                        terminal.queue_draw();
                    }
                    Event::PtyWrite(text) => terminal.write(text.into_bytes(), false),
                    Event::TextAreaSizeRequest(reply) => {
                        terminal.write(reply(terminal.size().0).into_bytes(), false)
                    }
                    Event::ColorRequest(index, reply) => {
                        if let Some(grid) = terminal.imp().grid.borrow().as_ref() {
                            let content = grid.lock();
                            let color = content.renderable_content().colors[index]
                                .unwrap_or_else(|| palette(index));
                            terminal.write(reply(color).into_bytes(), false);
                        }
                    }
                    Event::ChildExit(exit) => status = exit.code().unwrap_or(1),
                    Event::Exit => {
                        terminal.imp().channel.take();
                        terminal.set_input_enabled(false);
                        terminal.queue_draw();
                        for handler in terminal.imp().exits.borrow().iter() {
                            handler(&terminal, status);
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });
        callback(Ok(()));
        self.queue_draw();
    }

    pub fn copy_text(&self) {
        self.request_selection(|text| {
            if let Some(text) = text {
                crate::agent_render::clipboard().set_text(text);
            }
        });
    }

    pub fn paste_text(&self) {
        let weak = self.downgrade();
        crate::agent_render::clipboard().request_text(move |_, text| {
            let (Some(terminal), Some(text)) = (weak.upgrade(), text) else {
                return;
            };
            let bracketed = terminal.mode(TermMode::BRACKETED_PASTE);
            let text = if bracketed {
                format!("\x1b[200~{}\x1b[201~", text.replace(['\x1b', '\x03'], ""))
            } else {
                text.replace("\r\n", "\r").replace('\n', "\r")
            };
            terminal.write(text.into_bytes(), true);
        });
    }

    pub fn request_selection(&self, callback: impl FnOnce(Option<&str>) + 'static) -> bool {
        let selection = self
            .imp()
            .grid
            .borrow()
            .as_ref()
            .and_then(|grid| grid.lock().selection_to_string());
        if let Some(selection) = selection {
            callback(Some(&selection));
            true
        } else {
            false
        }
    }

    fn mode(&self, mode: TermMode) -> bool {
        self.imp()
            .grid
            .borrow()
            .as_ref()
            .is_some_and(|grid| grid.lock().mode().contains(mode))
    }

    fn write(&self, bytes: Vec<u8>, user: bool) {
        if user {
            if !self.imp().input.get() {
                return;
            }
            self.scroll(Scroll::Bottom);
        }
        if let Some(channel) = self.imp().channel.borrow().as_ref() {
            let _ = channel.send(Msg::Input(bytes.into()));
        }
    }

    fn key(&self, event: &gdk::EventKey, input: &gtk::IMMulticontext) -> glib::Propagation {
        use gdk::keys::constants::*;
        let modifiers = event.state();
        let ctrl = modifiers.contains(gdk::ModifierType::CONTROL_MASK);
        let shift = modifiers.contains(gdk::ModifierType::SHIFT_MASK);
        let alt = modifiers.contains(gdk::ModifierType::MOD1_MASK);
        let key = event.keyval();
        if ctrl && shift && matches!(key.to_lower(), c | v) {
            return glib::Propagation::Proceed;
        }
        if shift && !ctrl && matches!(key, Page_Up | Page_Down) {
            self.scroll(if key == Page_Up {
                Scroll::PageUp
            } else {
                Scroll::PageDown
            });
            return glib::Propagation::Stop;
        }
        if !ctrl && !alt && input.filter_keypress(event) {
            return glib::Propagation::Stop;
        }
        let cursor = self.mode(TermMode::APP_CURSOR);
        let sequence = match key {
            Return | KP_Enter => "\r",
            BackSpace => "\x7f",
            Escape => "\x1b",
            Tab if shift => "\x1b[Z",
            Tab => "\t",
            Up if cursor => "\x1bOA",
            Down if cursor => "\x1bOB",
            Right if cursor => "\x1bOC",
            Left if cursor => "\x1bOD",
            Up => "\x1b[A",
            Down => "\x1b[B",
            Right => "\x1b[C",
            Left => "\x1b[D",
            Home => "\x1b[H",
            End => "\x1b[F",
            Delete => "\x1b[3~",
            Insert => "\x1b[2~",
            Page_Up => "\x1b[5~",
            Page_Down => "\x1b[6~",
            F1 => "\x1bOP",
            F2 => "\x1bOQ",
            F3 => "\x1bOR",
            F4 => "\x1bOS",
            F5 => "\x1b[15~",
            F6 => "\x1b[17~",
            F7 => "\x1b[18~",
            F8 => "\x1b[19~",
            F9 => "\x1b[20~",
            F10 => "\x1b[21~",
            F11 => "\x1b[23~",
            F12 => "\x1b[24~",
            _ => {
                let Some(character) = key.to_unicode() else {
                    return glib::Propagation::Proceed;
                };
                let mut text = String::new();
                if alt {
                    text.push('\x1b');
                }
                if ctrl && character.is_ascii() {
                    text.push(char::from((character as u8).to_ascii_uppercase() & 0x1f));
                } else {
                    text.push(character);
                }
                self.write(text.into_bytes(), true);
                return glib::Propagation::Stop;
            }
        };
        self.write(sequence.as_bytes().to_vec(), true);
        glib::Propagation::Stop
    }

    fn size(&self) -> Size {
        let layout = self.create_pango_layout(Some("M"));
        layout.set_font_description(Some(&pango::FontDescription::from_string(FONT)));
        let (width, height) = layout.pixel_size();
        let (width, height) = (width.max(1), height.max(1) + 1);
        Size(WindowSize {
            num_cols: if self.allocated_width() <= 1 {
                80
            } else {
                (self.allocated_width() / width).clamp(2, 500) as u16
            },
            num_lines: if self.allocated_height() <= 1 {
                24
            } else {
                (self.allocated_height() / height).clamp(2, 250) as u16
            },
            cell_width: width as u16,
            cell_height: height as u16,
        })
    }

    fn resize(&self) {
        if self.allocated_width() < 24 || self.allocated_height() < 24 {
            return;
        }
        if let Some(grid) = self.imp().grid.borrow().as_ref() {
            let size = self.size();
            let mut grid = grid.lock();
            if grid.columns() != size.columns() || grid.screen_lines() != size.screen_lines() {
                grid.resize(size);
                if let Some(channel) = self.imp().channel.borrow().as_ref() {
                    let _ = channel.send(Msg::Resize(size.0));
                }
            }
        }
    }

    fn select(&self, (x, y): (f64, f64), start: bool) {
        let size = self.size();
        let column = (x / f64::from(size.0.cell_width)).floor();
        let side = if x / f64::from(size.0.cell_width) - column > 0.5 {
            Side::Right
        } else {
            Side::Left
        };
        if let Some(grid) = self.imp().grid.borrow().as_ref() {
            let mut grid = grid.lock();
            let row = (y / f64::from(size.0.cell_height)).floor() as i32;
            let line =
                row.clamp(0, grid.screen_lines() as i32 - 1) - grid.grid().display_offset() as i32;
            let point = Point::new(
                Line(line),
                Column((column as usize).min(grid.columns() - 1)),
            );
            if start {
                grid.selection = Some(Selection::new(SelectionType::Simple, point, side));
            } else if let Some(selection) = &mut grid.selection {
                selection.update(point, side);
            }
            self.queue_draw();
        }
    }

    fn scroll(&self, scroll: Scroll) {
        if let Some(grid) = self.imp().grid.borrow().as_ref() {
            grid.lock().scroll_display(scroll);
            self.queue_draw();
        }
    }

    fn paint(&self, cr: &cairo::Context) {
        paint_color(cr, rgb(BACKGROUND));
        let _ = cr.paint();
        let layout = self.create_pango_layout(None);
        layout.set_font_description(Some(&pango::FontDescription::from_string(FONT)));
        let size = self.size();
        let (width, height) = (f64::from(size.0.cell_width), f64::from(size.0.cell_height));
        let grid = self.imp().grid.borrow();
        let Some(grid) = grid.as_ref() else {
            paint_color(cr, rgb(0xd8e1ed));
            layout.set_text(&self.imp().notice.borrow().replace('\r', ""));
            pangocairo::functions::show_layout(cr, &layout);
            return;
        };
        let grid = grid.lock();
        let content = grid.renderable_content();
        for cell in content.display_iter {
            let x = cell.point.column.0 as f64 * width;
            let y = (cell.point.line.0 + content.display_offset as i32) as f64 * height;
            let (mut fg, mut bg) = (
                terminal_color(content.colors, cell.fg),
                terminal_color(content.colors, cell.bg),
            );
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            if content
                .selection
                .as_ref()
                .is_some_and(|selection| selection.contains(cell.point))
            {
                bg = rgb(0x304c78);
            }
            if bg != rgb(BACKGROUND) {
                paint_color(cr, bg);
                cr.rectangle(x, y, width, height);
                let _ = cr.fill();
            }
            if cell.c == ' '
                || cell.flags.intersects(
                    Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER | Flags::HIDDEN,
                )
            {
                continue;
            }
            let mut text = String::new();
            text.push(cell.c);
            if let Some(marks) = cell.zerowidth() {
                text.extend(marks);
            }
            layout.set_text(&text);
            paint_color(cr, fg);
            cr.move_to(x, y);
            pangocairo::functions::show_layout(cr, &layout);
        }
        let cursor = content.cursor;
        if cursor.shape != CursorShape::Hidden && content.display_offset == 0 {
            paint_color(cr, rgb(0x9bcac6));
            cr.rectangle(
                cursor.point.column.0 as f64 * width + 0.5,
                cursor.point.line.0 as f64 * height + 0.5,
                width - 1.0,
                height - 1.0,
            );
            cr.set_line_width(1.0);
            let _ = cr.stroke();
        }
    }
}

fn paint_color(cr: &cairo::Context, color: Rgb) {
    cr.set_source_rgb(
        f64::from(color.r) / 255.0,
        f64::from(color.g) / 255.0,
        f64::from(color.b) / 255.0,
    );
}

fn rgb(color: u32) -> Rgb {
    Rgb {
        r: (color >> 16) as u8,
        g: (color >> 8) as u8,
        b: color as u8,
    }
}

fn terminal_color(colors: &Colors, color: Color) -> Rgb {
    let index = match color {
        Color::Spec(color) => return color,
        Color::Indexed(index) => usize::from(index),
        Color::Named(color) => color as usize,
    };
    colors[index].unwrap_or_else(|| palette(index))
}

fn palette(index: usize) -> Rgb {
    match index {
        0..=15 => rgb(PALETTE[index]),
        16..=231 => {
            let index = index - 16;
            let level = |n: usize| if n == 0 { 0 } else { (55 + n * 40) as u8 };
            Rgb {
                r: level(index / 36),
                g: level(index / 6 % 6),
                b: level(index % 6),
            }
        }
        232..=255 => {
            let shade = (8 + (index - 232) * 10) as u8;
            Rgb {
                r: shade,
                g: shade,
                b: shade,
            }
        }
        index if index == NamedColor::Background as usize => rgb(BACKGROUND),
        _ => rgb(0xd8e1ed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_pty_runs_windows_command() {
        gtk::init().expect("Windows desktop is available");
        let terminal = Terminal::new();
        terminal.set_scrollback_lines(100);
        let exit = Rc::new(Cell::new(None));
        let result = exit.clone();
        terminal.connect_child_exited(move |_, code| result.set(Some(code)));
        let cancellable = gio::Cancellable::new();
        terminal.spawn(
            None,
            &["cmd.exe", "/C", "echo SPAN_NATIVE_WINDOWS"],
            &[],
            &cancellable,
            |result| {
                result.expect("start Windows ConPTY");
            },
        );
        let context = glib::MainContext::default();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        while exit.get().is_none() && std::time::Instant::now() < deadline {
            context.iteration(false);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(exit.get(), Some(0));
        let grid = terminal.imp().grid.borrow();
        let grid = grid.as_ref().unwrap().lock();
        let output: String = grid.grid().display_iter().map(|cell| cell.c).collect();
        assert!(
            output.contains("SPAN_NATIVE_WINDOWS"),
            "terminal output was {output:?}"
        );
    }

    use std::rc::Rc;
}
