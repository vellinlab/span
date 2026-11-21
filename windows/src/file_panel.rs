use crate::{files, theme};
use files::{Kind, Source};
use iced::widget::{
    Space, button, column, container, image, markdown, row, rule, scrollable, svg, text,
    text_editor, text_input,
};
use iced::{Center, Element, Fill, Task, Theme};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const PREVIEW_LIMIT: usize = 12 * 1024 * 1024;
const FILE_ROWS: usize = 120;

#[derive(Debug, Clone)]
pub enum Action {
    Path(String),
    Navigate,
    Open(PathBuf, bool),
    Parent,
    Refresh,
    Hidden,
    Next,
    Upload,
    Download,
    Listing(u64, Result<Arc<Snapshot>, String>),
    Preview(u64, PathBuf, Result<Arc<Decoded>, String>),
    Transfer(Result<bool, String>),
    SelectText(text_editor::Action),
    Link(String),
    Close,
    Zoom(i8),
}

#[derive(Debug)]
pub struct Snapshot {
    path: PathBuf,
    rows: Vec<FileRow>,
    truncated: bool,
}

#[derive(Debug)]
struct FileRow {
    path: PathBuf,
    title: String,
    directory: bool,
    hidden: bool,
    size: Option<u64>,
}

#[derive(Debug)]
pub enum Decoded {
    Image(image::Handle),
    Vector(svg::Handle),
    Source(String),
    Markdown(String),
}

enum Preview {
    Image(image::Handle),
    Vector(svg::Handle),
    Source(text_editor::Content, String),
    Markdown(markdown::Content),
}

pub struct Panel {
    source: Source,
    folder: Option<PathBuf>,
    path: String,
    rows: Option<Arc<Snapshot>>,
    visible_rows: usize,
    hidden: bool,
    selected: Option<PathBuf>,
    preview: Option<(PathBuf, Preview)>,
    list_id: u64,
    preview_id: u64,
    listing: bool,
    transferring: bool,
    status: Option<String>,
    zoom: f32,
}

impl Panel {
    pub fn new(host: Option<String>) -> (Self, Task<Action>) {
        let source = host.map_or(Source::Local, |host| Source::Sftp { socket: Some(host) });
        let mut panel = Self {
            source,
            folder: None,
            path: String::new(),
            rows: None,
            visible_rows: FILE_ROWS,
            hidden: false,
            selected: None,
            preview: None,
            list_id: 0,
            preview_id: 0,
            listing: false,
            transferring: false,
            status: None,
            zoom: 1.0,
        };
        let task = panel.list(None);
        (panel, task)
    }

    pub fn has_preview(&self) -> bool {
        self.preview.is_some()
    }

    fn list(&mut self, path: Option<PathBuf>) -> Task<Action> {
        self.list_id += 1;
        self.listing = true;
        self.status = None;
        let id = self.list_id;
        let source = self.source.clone();
        background(
            move || {
                let directory = source.list(path.as_deref())?;
                let rows = directory
                    .entries
                    .into_iter()
                    .map(|entry| {
                        let directory_item = entry.kind == Kind::Directory;
                        FileRow {
                            path: directory.path.join(&entry.name),
                            title: files::display(&entry.name),
                            directory: directory_item,
                            hidden: entry.hidden(),
                            size: if directory_item { None } else { entry.size },
                        }
                    })
                    .collect();
                Ok(Arc::new(Snapshot {
                    path: directory.path,
                    rows,
                    truncated: directory.truncated,
                }))
            },
            move |result| Action::Listing(id, result),
        )
    }

    pub fn preview_file(&mut self, path: PathBuf) -> Task<Action> {
        self.preview_id += 1;
        self.selected = Some(path.clone());
        self.status = None;
        let id = self.preview_id;
        let source = self.source.clone();
        let target = path.clone();
        background(
            move || {
                let data = source.preview(&target, PREVIEW_LIMIT)?;
                let extension = target
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                match extension.as_str() {
                    "svg" => Ok(Arc::new(Decoded::Vector(svg::Handle::from_memory(data)))),
                    "png" | "jpg" | "jpeg" => {
                        let reader = ::image::ImageReader::new(std::io::Cursor::new(&data))
                            .with_guessed_format()
                            .map_err(|error| error.to_string())?;
                        let (width, height) = reader
                            .into_dimensions()
                            .map_err(|error| error.to_string())?;
                        if u64::from(width) * u64::from(height) > 5_000_000 {
                            return Err("The image is too large for inline preview. Download it to open it at full resolution.".into());
                        }
                        let decoded = ::image::load_from_memory(&data)
                            .map_err(|error| error.to_string())?
                            .into_rgba8();
                        Ok(Arc::new(Decoded::Image(image::Handle::from_rgba(
                            width,
                            height,
                            decoded.into_raw(),
                        ))))
                    }
                    "md" | "markdown" => String::from_utf8(data)
                        .map(|text| Arc::new(Decoded::Markdown(text)))
                        .map_err(|error| error.to_string()),
                    _ => {
                        if data.len() > 512 * 1024 || data.contains(&0) {
                            return Err("This file is too large or has a binary format. Use Download to open it externally.".into());
                        }
                        String::from_utf8(data)
                            .map(|text| Arc::new(Decoded::Source(text)))
                            .map_err(|_| "This file is not UTF-8 text.".into())
                    }
                }
            },
            move |result| Action::Preview(id, path.clone(), result),
        )
    }

    pub fn update(&mut self, action: Action) -> Task<Action> {
        match action {
            Action::Path(path) => self.path = path,
            Action::Navigate => {
                if !self.path.trim().is_empty() {
                    return self.list(Some(PathBuf::from(self.path.trim())));
                }
            }
            Action::Parent => {
                if let Some(parent) = self.folder.as_deref().and_then(Path::parent) {
                    return self.list(Some(parent.to_path_buf()));
                }
            }
            Action::Refresh => return self.list(self.folder.clone()),
            Action::Open(path, true) => return self.list(Some(path)),
            Action::Open(path, false) => return self.preview_file(path),
            Action::Hidden => self.hidden = !self.hidden,
            Action::Next => self.visible_rows += FILE_ROWS,
            Action::Listing(id, result) if id == self.list_id => {
                self.listing = false;
                match result {
                    Ok(snapshot) => {
                        self.path = display_path(&snapshot.path, &self.source);
                        self.folder = Some(snapshot.path.clone());
                        self.selected = None;
                        self.visible_rows = FILE_ROWS;
                        self.rows = Some(snapshot);
                    }
                    Err(error) => self.status = Some(error),
                }
            }
            Action::Preview(id, path, result) if id == self.preview_id => match result {
                Ok(data) => {
                    self.zoom = 1.0;
                    let preview = match &*data {
                        Decoded::Image(handle) => Preview::Image(handle.clone()),
                        Decoded::Vector(handle) => Preview::Vector(handle.clone()),
                        Decoded::Source(text) => {
                            let extension = path
                                .extension()
                                .and_then(|ext| ext.to_str())
                                .unwrap_or("txt")
                                .to_owned();
                            Preview::Source(text_editor::Content::with_text(text), extension)
                        }
                        Decoded::Markdown(text) => {
                            Preview::Markdown(markdown::Content::parse(text))
                        }
                    };
                    self.preview = Some((path, preview));
                }
                Err(error) => self.status = Some(error),
            },
            Action::Close => {
                self.preview_id += 1;
                self.preview = None;
            }
            Action::Zoom(step) => self.zoom = (self.zoom + f32::from(step) * 0.25).clamp(0.5, 3.0),
            Action::SelectText(action) if !action.is_edit() => {
                if let Some((_, Preview::Source(content, _))) = &mut self.preview {
                    content.perform(action);
                }
            }
            Action::Link(link) => {
                if (link.starts_with("http://") || link.starts_with("https://"))
                    && let Err(error) = open::that_detached(link)
                {
                    self.status = Some(error.to_string());
                }
            }
            Action::Upload if !self.transferring => {
                if let Some(folder) = self.folder.clone() {
                    self.transferring = true;
                    let source = self.source.clone();
                    return background(
                        move || {
                            let Some(local) = rfd::FileDialog::new().pick_file() else {
                                return Ok(false);
                            };
                            let name = local.file_name().ok_or("The file does not have a name.")?;
                            source.upload(&local, &folder.join(name))?;
                            Ok(true)
                        },
                        Action::Transfer,
                    );
                }
            }
            Action::Download if !self.transferring => {
                if let Some(path) = self.selected.clone() {
                    self.transferring = true;
                    let source = self.source.clone();
                    return background(
                        move || {
                            let name = path.file_name().ok_or("The file does not have a name.")?;
                            let Some(destination) = rfd::FileDialog::new()
                                .set_file_name(name.to_string_lossy())
                                .save_file()
                            else {
                                return Ok(false);
                            };
                            source.download(&path, &destination)?;
                            Ok(false)
                        },
                        Action::Transfer,
                    );
                }
            }
            Action::Transfer(result) => {
                self.transferring = false;
                match result {
                    Ok(true) => return self.list(self.folder.clone()),
                    Ok(false) => self.status = None,
                    Err(error) => self.status = Some(error),
                }
            }
            _ => {}
        }
        Task::none()
    }

    pub fn sidebar(&self) -> Element<'_, Action> {
        let mut list = column![].spacing(2);
        if let Some(snapshot) = &self.rows {
            let mut entries = snapshot
                .rows
                .iter()
                .filter(|entry| self.hidden || !entry.hidden);
            for entry in entries.by_ref().take(self.visible_rows) {
                let selected = self.selected.as_ref() == Some(&entry.path);
                let icon = if entry.directory { "▱" } else { "·" };
                let size = entry.size.map(size_name).unwrap_or_default();
                let control = button(
                    row![
                        text(icon).color(theme::BLUE),
                        text(&entry.title)
                            .size(13)
                            .width(Fill)
                            .wrapping(iced::widget::text::Wrapping::WordOrGlyph),
                        text(size).size(11).color(theme::MUTED),
                    ]
                    .align_y(Center)
                    .spacing(8),
                )
                .on_press(Action::Open(entry.path.clone(), entry.directory))
                .style(move |_, status| theme::tab(selected, status))
                .padding([5, 6])
                .width(Fill);
                list = list.push(control);
            }
            if entries.next().is_some() {
                list = list.push(action("More files", Some(Action::Next)));
            } else if snapshot.truncated {
                list = list.push(
                    text("Directory listing reached its limit.")
                        .size(12)
                        .color(theme::MUTED),
                );
            }
        }
        let details = self.status.as_deref().unwrap_or(if self.listing {
            "Reading directory…"
        } else if self.transferring {
            "Transferring…"
        } else {
            ""
        });
        column![
            text("Files").size(16).font(theme::SEMIBOLD),
            row![
                action("↑", Some(Action::Parent)),
                text_input("Directory", &self.path)
                    .on_input(Action::Path)
                    .on_submit(Action::Navigate)
                    .padding(6)
                    .size(13),
                action("↻", Some(Action::Refresh)),
            ]
            .spacing(4)
            .align_y(Center),
            row![
                action(
                    "Upload",
                    (!self.transferring && self.folder.is_some()).then_some(Action::Upload)
                ),
                action(
                    "Download",
                    (!self.transferring && self.selected.is_some()).then_some(Action::Download)
                ),
                action(
                    if self.hidden {
                        "Hide dotfiles"
                    } else {
                        "Show dotfiles"
                    },
                    Some(Action::Hidden)
                ),
            ]
            .spacing(4),
            scrollable(list).height(Fill),
            text(details).size(12).color(theme::MUTED),
        ]
        .spacing(8)
        .height(Fill)
        .into()
    }

    pub fn view<'a>(&'a self, theme: &'a Theme) -> Element<'a, Action> {
        let Some((path, preview)) = &self.preview else {
            return Space::new().into();
        };
        let name = path.file_name().map(files::display).unwrap_or_default();
        let image_width = 430.0 * self.zoom;
        let image_height = 380.0 * self.zoom;
        let (content, can_zoom) = match preview {
            Preview::Image(handle) => (
                scrollable(
                    image(handle.clone())
                        .width(image_width)
                        .height(image_height),
                )
                .direction(scrollable::Direction::Both {
                    vertical: scrollable::Scrollbar::new(),
                    horizontal: scrollable::Scrollbar::new(),
                })
                .into(),
                true,
            ),
            Preview::Vector(handle) => (
                scrollable(svg(handle.clone()).width(image_width).height(image_height))
                    .direction(scrollable::Direction::Both {
                        vertical: scrollable::Scrollbar::new(),
                        horizontal: scrollable::Scrollbar::new(),
                    })
                    .into(),
                true,
            ),
            Preview::Source(content, language) => (
                text_editor(content)
                    .height(Fill)
                    .font(iced::Font::with_name("Consolas"))
                    .size(13)
                    .padding(12)
                    .on_action(Action::SelectText)
                    .wrapping(iced::widget::text::Wrapping::None)
                    .highlight(language, iced::highlighter::Theme::Base16Ocean)
                    .into(),
                false,
            ),
            Preview::Markdown(document) => (
                scrollable(
                    container(
                        markdown::view(
                            document.items(),
                            markdown::Settings::with_text_size(15, theme),
                        )
                        .map(Action::Link),
                    )
                    .padding(14),
                )
                .height(Fill)
                .into(),
                false,
            ),
        };
        let mut header = row![text(name).size(14).font(theme::SEMIBOLD).width(Fill)]
            .spacing(6)
            .align_y(Center);
        if can_zoom {
            header = header
                .push(action("−", Some(Action::Zoom(-1))))
                .push(
                    text(format!("{:.0}%", self.zoom * 100.0))
                        .size(12)
                        .color(theme::MUTED),
                )
                .push(action("+", Some(Action::Zoom(1))));
        }
        container(
            column![
                container(header.push(action("×", Some(Action::Close))))
                    .padding(8)
                    .width(Fill),
                rule::horizontal(1).style(theme::rule),
                content,
            ]
            .height(Fill),
        )
        .width(Fill)
        .height(Fill)
        .style(|_| theme::surface(theme::SIDE))
        .into()
    }
}

fn background<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
    ready: impl Fn(Result<T, String>) -> Action + Send + 'static,
) -> Task<Action> {
    let (sender, result) = futures::channel::oneshot::channel();
    std::thread::spawn(move || {
        let _ = sender.send(operation());
    });
    Task::perform(
        async move {
            result
                .await
                .unwrap_or_else(|_| Err("The file operation ended unexpectedly.".into()))
        },
        ready,
    )
}

fn action(label: &str, action: Option<Action>) -> button::Button<'_, Action> {
    button(text(label).size(12))
        .on_press_maybe(action)
        .style(|_, status| theme::tab(false, status))
        .padding([4, 6])
}

fn display_path(path: &Path, source: &Source) -> String {
    let path = path.to_string_lossy();
    if matches!(source, Source::Local) {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
    } else {
        path.replace('\\', "/")
    }
}

fn size_name(size: u64) -> String {
    if size >= 1_048_576 {
        format!("{:.1} MB", size as f64 / 1_048_576.0)
    } else if size >= 1024 {
        format!("{} KB", size.div_ceil(1024))
    } else {
        format!("{size} B")
    }
}
