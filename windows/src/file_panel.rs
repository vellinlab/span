use crate::{files, theme};
use files::{Kind, Source};
use iced::widget::{
    Space, button, column, container, image, markdown, row, rule, scrollable, svg, text,
    text_editor, text_input, tooltip,
};
use iced::{Center, Element, Fill, Task, Theme};
use std::borrow::Cow;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

const PREVIEW_LIMIT: usize = 12 * 1024 * 1024;
const FILE_ROWS: usize = 120;
const SUGGESTION_ROWS: usize = 7;
const SUGGESTION_DELAY: Duration = Duration::from_millis(150);
const DIRECTORY_FRESHNESS: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub enum Action {
    Path(String),
    Suggest(u64),
    Suggested(u64, Option<PathBuf>, Option<Arc<Snapshot>>),
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
    completion: Completion,
}

#[derive(Default)]
struct Completion {
    revision: u64,
    editing: bool,
    ready: bool,
    pending: bool,
    directories: VecDeque<CachedDirectory>,
    matches: Vec<(PathBuf, String)>,
}

struct CachedDirectory {
    request: Option<PathBuf>,
    snapshot: Option<Arc<Snapshot>>,
    fetched: Instant,
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
            completion: Completion::default(),
        };
        let task = panel.list(None);
        (panel, task)
    }

    pub fn has_preview(&self) -> bool {
        self.preview.is_some()
    }

    #[cfg(feature = "visual-check")]
    pub fn visual_folder(&self) -> Option<&Path> {
        self.folder.as_deref()
    }

    #[cfg(feature = "visual-check")]
    pub fn visual_matches(&self) -> impl Iterator<Item = &str> {
        self.completion
            .matches
            .iter()
            .map(|(_, title)| title.as_str())
    }

    pub fn cancel_suggestions(&mut self) {
        self.completion.revision += 1;
        self.completion.editing = false;
        self.completion.ready = false;
        self.completion.matches.clear();
    }

    fn resolve(&self, path: &Path) -> PathBuf {
        self.folder
            .as_ref()
            .map_or_else(|| path.to_path_buf(), |folder| folder.join(path))
    }

    fn directory_for(&self, request: &Option<PathBuf>) -> Option<Option<&Snapshot>> {
        if let (Some(rows), Some(path)) = (&self.rows, request)
            && Path::new(&display_path(&rows.path, &self.source))
                == Path::new(&display_path(path, &self.source))
        {
            return Some(Some(rows));
        }
        self.completion
            .directories
            .iter()
            .find(|entry| {
                &entry.request == request && entry.fetched.elapsed() < DIRECTORY_FRESHNESS
            })
            .map(|entry| entry.snapshot.as_deref())
    }

    fn fetch_suggestion_directory(&mut self, parent: Option<PathBuf>) -> Task<Action> {
        if self.completion.pending {
            return Task::none();
        }
        self.completion.pending = true;
        let listing = self.list_id;
        let source = self.source.clone();
        let request = parent.clone();
        background(
            move || read_directory(&source, request.as_deref()),
            move |result| Action::Suggested(listing, parent.clone(), result.ok()),
        )
    }

    fn suggest(&mut self) -> Task<Action> {
        if !self.completion.ready {
            return Task::none();
        }
        let local = matches!(self.source, Source::Local);
        let (base, prefix) = split_address(&self.path, local);
        let parent = if base.is_empty() {
            self.folder.clone()
        } else {
            Some(self.resolve(Path::new(base.as_ref())))
        };
        let Some(snapshot) = self.directory_for(&parent) else {
            return self.fetch_suggestion_directory(parent);
        };
        let Some(snapshot) = snapshot else {
            self.completion.matches.clear();
            return Task::none();
        };
        let prefix = if local {
            prefix.to_lowercase()
        } else {
            prefix.to_owned()
        };
        if !prefix.is_empty()
            && let Some(folder) = snapshot.rows.iter().find(|row| {
                row.directory
                    && if local {
                        row.title.eq_ignore_ascii_case(&prefix)
                            || (!row.title.is_ascii() && row.title.to_lowercase() == prefix)
                    } else {
                        row.title == prefix
                    }
            })
        {
            let exact = Some(folder.path.clone());
            match self.directory_for(&exact) {
                Some(Some(children)) => {
                    let children = completion_rows(children, "", self.hidden, local);
                    if !children.is_empty() {
                        self.completion.matches = children;
                        return Task::none();
                    }
                }
                None => return self.fetch_suggestion_directory(exact),
                Some(None) => {}
            }
        }
        self.completion.matches = completion_rows(snapshot, &prefix, self.hidden, local);
        Task::none()
    }

    fn list(&mut self, path: Option<PathBuf>) -> Task<Action> {
        self.cancel_suggestions();
        self.completion.directories.clear();
        self.list_id += 1;
        self.listing = true;
        self.status = None;
        let id = self.list_id;
        let source = self.source.clone();
        background(
            move || read_directory(&source, path.as_deref()),
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
            Action::Path(path) => {
                self.path = path;
                self.cancel_suggestions();
                if !self.path.is_empty() {
                    self.completion.editing = true;
                    let revision = self.completion.revision;
                    return Task::perform(
                        async { tokio::time::sleep(SUGGESTION_DELAY).await },
                        move |()| Action::Suggest(revision),
                    );
                }
            }
            Action::Suggest(revision) if self.completion.revision == revision => {
                self.completion.ready = self.completion.editing;
                return self.suggest();
            }
            Action::Suggested(listing, parent, snapshot) => {
                self.completion.pending = false;
                if listing == self.list_id {
                    self.completion
                        .directories
                        .retain(|cached| cached.request != parent);
                    self.completion.directories.push_front(CachedDirectory {
                        request: parent,
                        snapshot,
                        fetched: Instant::now(),
                    });
                    self.completion.directories.truncate(3);
                }
                return self.suggest();
            }
            Action::Navigate => {
                if !self.path.trim().is_empty() {
                    let local = matches!(self.source, Source::Local);
                    let (parent, _) = split_address(&self.path, local);
                    let path = match &parent {
                        Cow::Owned(drive_root) => drive_root.as_str(),
                        Cow::Borrowed(_) => &self.path,
                    };
                    return self.list(Some(self.resolve(Path::new(path))));
                }
            }
            Action::Parent => {
                if let Some(parent) = self.folder.as_deref().and_then(Path::parent) {
                    return self.list(Some(parent.to_path_buf()));
                }
            }
            Action::Refresh => return self.list(self.folder.clone()),
            Action::Open(path, true) => return self.list(Some(path)),
            Action::Open(path, false) => {
                self.cancel_suggestions();
                return self.preview_file(path);
            }
            Action::Hidden => {
                self.hidden = !self.hidden;
                return self.suggest();
            }
            Action::Next => self.visible_rows += FILE_ROWS,
            Action::Listing(id, result) if id == self.list_id => {
                self.listing = false;
                match result {
                    Ok(snapshot) => {
                        if !self.completion.editing {
                            self.path = display_path(&snapshot.path, &self.source);
                        }
                        self.folder = Some(snapshot.path.clone());
                        self.selected = None;
                        self.visible_rows = FILE_ROWS;
                        self.rows = Some(snapshot);
                        return self.suggest();
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
                let size = entry.size.map(size_name).unwrap_or_default();
                let control = button(
                    row![
                        (if entry.directory {
                            FileIcon::Folder
                        } else {
                            FileIcon::Document
                        })
                        .view(if entry.directory {
                            theme::BLUE
                        } else {
                            theme::MUTED
                        }),
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
        let mut sidebar = column![
            row![
                text("Files").size(16).font(theme::SEMIBOLD).width(Fill),
                (if self.hidden {
                    FileIcon::Eye
                } else {
                    FileIcon::EyeOff
                })
                .button(
                    if self.hidden {
                        "Hide hidden files"
                    } else {
                        "Show hidden files"
                    },
                    Action::Hidden,
                    self.hidden,
                ),
            ]
            .align_y(Center),
            row![
                FileIcon::Parent.button("Parent folder", Action::Parent, false),
                text_input("Directory", &self.path)
                    .on_input(Action::Path)
                    .on_submit(Action::Navigate)
                    .padding(6)
                    .size(13),
                FileIcon::Refresh.button("Refresh directory", Action::Refresh, false),
            ]
            .spacing(4)
            .align_y(Center),
        ]
        .spacing(8);
        if !self.completion.matches.is_empty() {
            let suggestions = column(self.completion.matches.iter().map(|(path, title)| {
                button(
                    row![
                        FileIcon::Folder.view(theme::BLUE),
                        text(title).size(13).width(Fill)
                    ]
                    .spacing(8)
                    .align_y(Center),
                )
                .on_press(Action::Open(path.clone(), true))
                .width(Fill)
                .padding([5, 8])
                .style(|_, status| theme::tab(false, status))
                .into()
            }))
            .spacing(2);
            sidebar = sidebar.push(
                container(suggestions)
                    .width(Fill)
                    .padding(4)
                    .style(|_| theme::panel(theme::CHROME, 9.0)),
            );
        }
        sidebar
            .push(
                row![
                    action(
                        "Upload",
                        (!self.transferring && self.folder.is_some()).then_some(Action::Upload)
                    ),
                    action(
                        "Download",
                        (!self.transferring && self.selected.is_some()).then_some(Action::Download)
                    ),
                ]
                .spacing(4),
            )
            .push(scrollable(list).height(Fill))
            .push(text(details).size(12).color(theme::MUTED))
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
        let (content, can_zoom): (Element<'a, Action>, bool) = match preview {
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
                    .font(theme::CODE_FONT)
                    .size(13)
                    .line_height(1.55)
                    .padding(12)
                    .on_action(Action::SelectText)
                    .wrapping(iced::widget::text::Wrapping::None)
                    .style(theme::editor)
                    .highlight(language, iced::highlighter::Theme::Base16Ocean)
                    .into(),
                false,
            ),
            Preview::Markdown(document) => (
                scrollable(
                    container(
                        theme::reading_markdown(
                            document.items(),
                            theme::BODY_SIZE,
                            theme::INK,
                            theme,
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
        .style(|_| theme::surface(theme::WORK))
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

fn read_directory(source: &Source, path: Option<&Path>) -> Result<Arc<Snapshot>, String> {
    let directory = source.list(path)?;
    let rows = directory
        .entries
        .into_iter()
        .map(|entry| {
            let is_directory = entry.kind == Kind::Directory;
            FileRow {
                path: directory.path.join(&entry.name),
                title: files::display(&entry.name),
                directory: is_directory,
                hidden: entry.hidden(),
                size: if is_directory { None } else { entry.size },
            }
        })
        .collect();
    Ok(Arc::new(Snapshot {
        path: directory.path,
        rows,
        truncated: directory.truncated,
    }))
}

fn split_address(value: &str, local: bool) -> (Cow<'_, str>, &str) {
    if local && matches!(value.as_bytes(), [drive, b':'] if drive.is_ascii_alphabetic()) {
        return (format!("{value}\\").into(), "");
    }
    let path = Path::new(value);
    if local && path.has_root() && path.parent().is_none() {
        return (value.into(), "");
    }
    let split = value
        .rfind(|c| c == '/' || (local && c == '\\'))
        .map_or(0, |index| index + 1);
    let (parent, prefix) = value.split_at(split);
    (parent.into(), prefix)
}

fn completion_rows(
    snapshot: &Snapshot,
    prefix: &str,
    hidden: bool,
    local: bool,
) -> Vec<(PathBuf, String)> {
    snapshot
        .rows
        .iter()
        .filter(|row| {
            row.directory
                && (hidden || !row.hidden || prefix.starts_with('.'))
                && if local {
                    row.title.to_lowercase().starts_with(prefix)
                } else {
                    row.title.starts_with(prefix)
                }
        })
        .take(SUGGESTION_ROWS)
        .map(|row| (row.path.clone(), row.title.clone()))
        .collect()
}

#[derive(Clone, Copy)]
enum FileIcon {
    Folder,
    Document,
    Eye,
    EyeOff,
    Parent,
    Refresh,
}

impl FileIcon {
    fn view(self, color: iced::Color) -> svg::Svg<'static, Theme> {
        static FOLDER: OnceLock<svg::Handle> = OnceLock::new();
        static DOCUMENT: OnceLock<svg::Handle> = OnceLock::new();
        static EYE: OnceLock<svg::Handle> = OnceLock::new();
        static EYE_OFF: OnceLock<svg::Handle> = OnceLock::new();
        static PARENT: OnceLock<svg::Handle> = OnceLock::new();
        static REFRESH: OnceLock<svg::Handle> = OnceLock::new();
        let (handle, path) = match self {
            Self::Folder => (
                &FOLDER,
                "M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
            ),
            Self::Document => (
                &DOCUMENT,
                "M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 0v5h5M8 13h8m-8 4h5",
            ),
            Self::Eye => (
                &EYE,
                "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zm10-2.7a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z",
            ),
            Self::EyeOff => (
                &EYE_OFF,
                "M3 3l18 18M10 6.2a11 11 0 0 1 2-.2c6.5 0 10 6 10 6a17 17 0 0 1-2.5 3m-3.5 2.3a11 11 0 0 1-4 .7C5.5 18 2 12 2 12a17 17 0 0 1 3.6-3.8",
            ),
            Self::Parent => (&PARENT, "M12 20V5m-5 5 5-5 5 5"),
            Self::Refresh => (&REFRESH, "M20 11a8 8 0 1 0-1.7 6M20 4v7h-7"),
        };
        let handle = handle.get_or_init(|| svg::Handle::from_memory(format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="{path}" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>"#
        ).into_bytes()));
        svg(handle.clone())
            .width(15)
            .height(15)
            .style(move |_, _| svg::Style { color: Some(color) })
    }

    fn button(
        self,
        label: &'static str,
        action: Action,
        selected: bool,
    ) -> Element<'static, Action> {
        let icon = button(self.view(if selected { theme::BLUE } else { theme::MUTED }))
            .on_press(action)
            .padding(6)
            .style(move |_, status| theme::tab(selected, status));
        tooltip(icon, theme::hint(label), tooltip::Position::Top).into()
    }
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
        if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{path}")
        } else if let Some(path) = path
            .strip_prefix(r"\\?\")
            .filter(|path| path.as_bytes().get(1) == Some(&b':'))
        {
            path.to_owned()
        } else {
            path.into_owned()
        }
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
