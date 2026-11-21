use crate::terminal_theme::{BACKGROUND, CURSOR, FOREGROUND, PALETTE, SELECTION};
use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, EventLoopSender, Msg};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point as CellPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Term, TermMode, cell::Flags, color::Colors};
use alacritty_terminal::tty;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, CursorShape, NamedColor, Rgb};
use futures::channel::mpsc;
use iced::keyboard::{Key, Modifiers, key::Named};
use iced::widget::canvas::{self, Frame};
use iced::{Color, Event as UiEvent, Font, Point, Rectangle, Size, mouse, window};
use std::cell::Cell;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const CELL_WIDTH: f32 = 8.4;
const CELL_HEIGHT: f32 = 19.0;
const TEXT_SIZE: f32 = 14.0;
const INSET: f32 = 16.0;

pub type TerminalId = u64;

#[derive(Clone)]
pub struct Events {
    id: TerminalId,
    sender: mpsc::UnboundedSender<(TerminalId, Event)>,
    pending: Arc<AtomicBool>,
}

impl EventListener for Events {
    fn send_event(&self, event: Event) {
        if matches!(event, Event::Wakeup) && self.pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.sender.unbounded_send((self.id, event));
    }
}

#[derive(Clone, Copy)]
struct GridSize(WindowSize);

impl GridSize {
    fn new(size: Size) -> Self {
        Self(WindowSize {
            num_cols: ((size.width - INSET * 2.0) / CELL_WIDTH).clamp(2.0, 500.0) as u16,
            num_lines: ((size.height - INSET * 2.0) / CELL_HEIGHT).clamp(2.0, 250.0) as u16,
            cell_width: CELL_WIDTH.round() as u16,
            cell_height: CELL_HEIGHT as u16,
        })
    }
}

impl Dimensions for GridSize {
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

pub struct Terminal {
    id: TerminalId,
    term: Arc<FairMutex<Term<Events>>>,
    channel: EventLoopSender,
    pending: Arc<AtomicBool>,
    size: Cell<GridSize>,
    cache: canvas::Cache,
    pub exit: Option<i32>,
}

impl Terminal {
    pub fn open(
        id: TerminalId,
        host: Option<&str>,
        cwd: Option<&Path>,
        sender: mpsc::UnboundedSender<(TerminalId, Event)>,
    ) -> Result<Self, String> {
        let size = GridSize::new(Size::new(704.0, 488.0));
        let (program, args) = match host {
            Some(host) => ("ssh.exe", vec!["-tt".into(), "--".into(), host.into()]),
            None => ("powershell.exe", vec!["-NoLogo".into()]),
        };
        let options = tty::Options {
            shell: Some(tty::Shell::new(program.into(), args)),
            working_directory: cwd.map(Path::to_path_buf),
            drain_on_exit: true,
            env: [("TERM".into(), "xterm-256color".into())].into(),
            escape_args: true,
        };
        let pty = tty::new(&options, size.0, 0).map_err(|error| error.to_string())?;
        let pending = Arc::new(AtomicBool::new(false));
        let events = Events {
            id,
            sender,
            pending: pending.clone(),
        };
        let config = Config {
            scrolling_history: 4_000,
            ..Config::default()
        };
        let term = Arc::new(FairMutex::new(Term::new(config, &size, events.clone())));
        let event_loop = EventLoop::new(term.clone(), events, pty, true, false)
            .map_err(|error| error.to_string())?;
        let channel = event_loop.channel();
        drop(event_loop.spawn());
        Ok(Self {
            id,
            term,
            channel,
            pending,
            size: Cell::new(size),
            cache: canvas::Cache::new(),
            exit: None,
        })
    }

    pub fn event(&mut self, event: Event) {
        match event {
            Event::Wakeup => {
                self.pending.store(false, Ordering::Release);
                self.cache.clear();
            }
            Event::PtyWrite(text) => self.write(text),
            Event::TextAreaSizeRequest(reply) => self.write(reply(self.size.get().0)),
            Event::ColorRequest(index, reply) => {
                let color = self.term.lock().renderable_content().colors[index]
                    .unwrap_or_else(|| palette(index));
                self.write(reply(color));
            }
            Event::ChildExit(status) => self.exit = Some(status.code().unwrap_or(1)),
            Event::Exit => {
                self.exit.get_or_insert(1);
            }
            _ => {}
        }
    }

    pub fn selection(&self) -> Option<String> {
        self.term.lock().selection_to_string()
    }

    pub fn paste(&self, value: String) {
        if self.mode(TermMode::BRACKETED_PASTE) {
            self.input(format!(
                "\x1b[200~{}\x1b[201~",
                value.replace(['\x1b', '\x03'], "")
            ));
        } else {
            self.input(value.replace("\r\n", "\r").replace('\n', "\r"));
        }
    }

    fn mode(&self, mode: TermMode) -> bool {
        self.term.lock().mode().contains(mode)
    }

    fn input(&self, text: String) {
        if self.exit.is_none() {
            self.scroll(Scroll::Bottom);
            self.write(text);
        }
    }

    fn write(&self, text: String) {
        let _ = self.channel.send(Msg::Input(text.into_bytes().into()));
    }

    fn scroll(&self, scroll: Scroll) {
        self.term.lock().scroll_display(scroll);
        self.cache.clear();
    }

    fn resize(&self, bounds: Size) {
        let next = GridSize::new(bounds);
        let previous = self.size.get();
        if previous.columns() != next.columns() || previous.screen_lines() != next.screen_lines() {
            self.size.set(next);
            self.term.lock().resize(next);
            let _ = self.channel.send(Msg::Resize(next.0));
            self.cache.clear();
        }
    }

    fn select(&self, position: Point, start: bool) {
        let x = ((position.x - INSET) / CELL_WIDTH).max(0.0);
        let y = ((position.y - INSET) / CELL_HEIGHT).max(0.0);
        let mut term = self.term.lock();
        let line =
            (y as usize).min(term.screen_lines() - 1) as i32 - term.grid().display_offset() as i32;
        let point = CellPoint::new(Line(line), Column((x as usize).min(term.columns() - 1)));
        let side = if x.fract() < 0.5 {
            Side::Left
        } else {
            Side::Right
        };
        if start {
            term.selection = Some(Selection::new(SelectionType::Simple, point, side));
        } else if let Some(selection) = term.selection.as_mut() {
            selection.update(point, side);
        }
        self.cache.clear();
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.channel.send(Msg::Shutdown);
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Clipboard {
    Copy(TerminalId),
    Paste(TerminalId),
}

#[derive(Default)]
pub struct Interaction {
    dragging: bool,
}

impl canvas::Program<Clipboard> for Terminal {
    type State = Interaction;

    fn update(
        &self,
        state: &mut Interaction,
        event: &UiEvent,
        bounds: Rectangle,
        cursor: mouse::Cursor,
    ) -> Option<canvas::Action<Clipboard>> {
        match event {
            UiEvent::Window(window::Event::RedrawRequested(_)) => {
                self.resize(bounds.size());
                None
            }
            UiEvent::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                let position = cursor.position_in(bounds)?;
                state.dragging = true;
                self.select(position, true);
                Some(canvas::Action::request_redraw().and_capture())
            }
            UiEvent::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => {
                state.dragging = false;
                None
            }
            UiEvent::Mouse(mouse::Event::CursorMoved { .. }) if state.dragging => {
                self.select(cursor.position_in(bounds)?, false);
                Some(canvas::Action::request_redraw().and_capture())
            }
            UiEvent::Mouse(mouse::Event::WheelScrolled { delta }) if cursor.is_over(bounds) => {
                let lines = match delta {
                    mouse::ScrollDelta::Lines { y, .. } => *y * 3.0,
                    mouse::ScrollDelta::Pixels { y, .. } => *y / CELL_HEIGHT,
                };
                self.scroll(Scroll::Delta(lines.round() as i32));
                Some(canvas::Action::request_redraw().and_capture())
            }
            UiEvent::Keyboard(iced::keyboard::Event::KeyPressed {
                key,
                modifiers,
                text,
                ..
            }) => {
                if modifiers.control() && modifiers.shift() {
                    let message = match key.as_ref() {
                        Key::Character("c" | "C") => Some(Clipboard::Copy(self.id)),
                        Key::Character("v" | "V") => Some(Clipboard::Paste(self.id)),
                        _ => None,
                    };
                    if let Some(message) = message {
                        return Some(canvas::Action::publish(message).and_capture());
                    }
                }
                let data = key_input(
                    key.as_ref(),
                    *modifiers,
                    text.as_deref(),
                    self.mode(TermMode::APP_CURSOR),
                )?;
                self.input(data);
                Some(canvas::Action::request_redraw().and_capture())
            }
            _ => None,
        }
    }

    fn draw(
        &self,
        _state: &Interaction,
        renderer: &iced::Renderer,
        _theme: &iced::Theme,
        bounds: Rectangle,
        _cursor: mouse::Cursor,
    ) -> Vec<canvas::Geometry> {
        vec![
            self.cache
                .draw(renderer, bounds.size(), |frame| self.paint(frame)),
        ]
    }
}

impl Terminal {
    fn paint(&self, frame: &mut Frame) {
        let term = self.term.lock();
        let content = term.renderable_content();
        let mut run = String::new();
        let mut origin = Point::ORIGIN;
        let mut last: Option<CellPoint> = None;
        let mut foreground = rgb(FOREGROUND);
        let flush = |frame: &mut Frame, run: &mut String, position, color| {
            if !run.trim_end().is_empty() {
                frame.fill_text(canvas::Text {
                    content: run.trim_end().to_owned(),
                    position,
                    color: display_color(color),
                    size: TEXT_SIZE.into(),
                    font: Font::with_name("Consolas"),
                    shaping: iced::advanced::text::Shaping::Advanced,
                    ..canvas::Text::default()
                });
            }
            run.clear();
        };
        for cell in content.display_iter {
            let point = cell.point;
            let position = grid_position(point, content.display_offset);
            let (mut fg, mut bg) = (
                terminal_color(content.colors, cell.fg),
                terminal_color(content.colors, cell.bg),
            );
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            if content
                .selection
                .is_some_and(|selection| selection.contains(point))
            {
                bg = rgb(SELECTION);
            }
            let render_ink = !cell.flags.intersects(
                Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER | Flags::HIDDEN,
            );
            let marks = cell.zerowidth();
            let batch = cell.c.is_ascii() && marks.is_none() && bg == rgb(BACKGROUND) && render_ink;
            if !batch
                || !last.is_some_and(|last| {
                    last.line == point.line
                        && last.column.0 + 1 == point.column.0
                        && foreground == fg
                })
            {
                flush(frame, &mut run, origin, foreground);
                origin = position;
                foreground = fg;
            }
            if bg != rgb(BACKGROUND) {
                frame.fill_rectangle(
                    position,
                    Size::new(CELL_WIDTH, CELL_HEIGHT),
                    display_color(bg),
                );
            }
            if render_ink {
                run.push(cell.c);
                if let Some(marks) = marks {
                    run.extend(marks);
                }
                if !batch {
                    flush(frame, &mut run, origin, foreground);
                }
            }
            last = batch.then_some(point);
        }
        flush(frame, &mut run, origin, foreground);

        let cursor = content.cursor;
        if self.exit.is_none() && cursor.shape != CursorShape::Hidden && content.display_offset == 0
        {
            let position = grid_position(cursor.point, 0);
            let color = display_color(rgb(CURSOR));
            if cursor.shape == CursorShape::Underline {
                frame.fill_rectangle(
                    Point::new(position.x, position.y + CELL_HEIGHT - 2.0),
                    Size::new(CELL_WIDTH, 2.0),
                    color,
                );
            } else {
                frame.fill_rectangle(position, Size::new(2.0, CELL_HEIGHT), color);
            }
        }
    }
}

fn grid_position(point: CellPoint, offset: usize) -> Point {
    Point::new(
        INSET + point.column.0 as f32 * CELL_WIDTH,
        INSET + (point.line.0 + offset as i32) as f32 * CELL_HEIGHT,
    )
}

fn key_input(
    key: Key<&str>,
    modifiers: Modifiers,
    text: Option<&str>,
    app_cursor: bool,
) -> Option<String> {
    let sequence = match key {
        Key::Named(key) => match key {
            Named::Enter => "\r",
            Named::Tab if modifiers.shift() => "\x1b[Z",
            Named::Tab => "\t",
            Named::Backspace => "\x7f",
            Named::Escape => "\x1b",
            Named::ArrowUp if app_cursor => "\x1bOA",
            Named::ArrowDown if app_cursor => "\x1bOB",
            Named::ArrowRight if app_cursor => "\x1bOC",
            Named::ArrowLeft if app_cursor => "\x1bOD",
            Named::ArrowUp => "\x1b[A",
            Named::ArrowDown => "\x1b[B",
            Named::ArrowRight => "\x1b[C",
            Named::ArrowLeft => "\x1b[D",
            Named::Home => "\x1b[H",
            Named::End => "\x1b[F",
            Named::Delete => "\x1b[3~",
            Named::Insert => "\x1b[2~",
            Named::PageUp => "\x1b[5~",
            Named::PageDown => "\x1b[6~",
            Named::F1 => "\x1bOP",
            Named::F2 => "\x1bOQ",
            Named::F3 => "\x1bOR",
            Named::F4 => "\x1bOS",
            Named::F5 => "\x1b[15~",
            Named::F6 => "\x1b[17~",
            Named::F7 => "\x1b[18~",
            Named::F8 => "\x1b[19~",
            Named::F9 => "\x1b[20~",
            Named::F10 => "\x1b[21~",
            Named::F11 => "\x1b[23~",
            Named::F12 => "\x1b[24~",
            _ => text?,
        },
        Key::Character(character) if modifiers.control() && !modifiers.alt() => {
            let byte = character.bytes().next()?.to_ascii_uppercase();
            return (character.len() == 1 && (b'@'..=b'_').contains(&byte))
                .then(|| char::from(byte & 0x1f).to_string());
        }
        _ => text?,
    };
    if modifiers.alt() && !modifiers.control() {
        Some(format!("\x1b{sequence}"))
    } else {
        Some(sequence.into())
    }
}

fn rgb(color: u32) -> Rgb {
    Rgb {
        r: (color >> 16) as u8,
        g: (color >> 8) as u8,
        b: color as u8,
    }
}

fn display_color(color: Rgb) -> Color {
    Color::from_rgb8(color.r, color.g, color.b)
}

fn terminal_color(colors: &Colors, color: AnsiColor) -> Rgb {
    let index = match color {
        AnsiColor::Spec(color) => return color,
        AnsiColor::Indexed(index) => usize::from(index),
        AnsiColor::Named(color) => color as usize,
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
        _ => rgb(FOREGROUND),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn conpty_powershell_round_trip() {
        let (sender, mut receiver) = mpsc::unbounded();
        let mut terminal =
            Terminal::open(1, None, None, sender).expect("start PowerShell in ConPTY");
        terminal.input("Write-Output ('span-' + 'native-ready')\rexit\r".into());
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            while let Ok((1, event)) = receiver.try_recv() {
                terminal.event(event);
            }
            let grid = terminal.term.lock();
            let text: String = grid
                .renderable_content()
                .display_iter
                .map(|cell| cell.c)
                .collect();
            if text.contains("span-native-ready") {
                return;
            }
            drop(grid);
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("The shell did not produce the output in the terminal grid");
    }
}
