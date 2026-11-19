use crate::icons::{self, Icon};
use gtk::prelude::*;
use gtk::{gdk_pixbuf, glib, pango};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::rc::Rc;

const MAX_FILES: usize = 6;
const MAX_BYTES: usize = 16 * 1024 * 1024;

pub struct Attachments {
    pub button: gtk::Button,
    pub chips: gtk::FlowBox,
    files: RefCell<Vec<PathBuf>>,
    pasted: RefCell<Vec<PathBuf>>,
}

impl Attachments {
    pub fn new() -> Rc<Self> {
        let button = gtk::Button::new();
        button.style_context().add_class("agent-picker");
        button.set_valign(gtk::Align::Center);
        button.set_tooltip_text(Some(
            "添加本机附件（最多 6 个，共 16 MiB），也可在输入框粘贴图片",
        ));
        if let Some(accessible) = button.accessible() {
            accessible.set_name("附件");
        }
        let content = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let label = gtk::Label::new(Some("附件"));
        label.set_valign(gtk::Align::Center);
        content.add(&icons::widget(Icon::Attachment, 16));
        content.add(&label);
        button.add(&content);
        let chips = gtk::FlowBox::new();
        chips.set_selection_mode(gtk::SelectionMode::None);
        chips.set_max_children_per_line(5);
        chips.set_column_spacing(6);
        chips.set_row_spacing(4);
        chips.set_no_show_all(true);
        Rc::new(Self {
            button,
            chips,
            files: RefCell::new(Vec::new()),
            pasted: RefCell::new(Vec::new()),
        })
    }

    pub fn choose(&self, on_chosen: impl Fn(Vec<PathBuf>) + 'static) {
        let parent = self.button.toplevel().and_downcast::<gtk::Window>();
        let chooser = gtk::FileChooserDialog::new(
            Some("添加附件"),
            parent.as_ref(),
            gtk::FileChooserAction::Open,
        );
        chooser.set_modal(true);
        chooser.set_destroy_with_parent(true);
        chooser.set_select_multiple(true);
        chooser.set_default_size(720, 540);
        chooser.set_current_folder(gtk::glib::home_dir());
        chooser.add_buttons(&[
            ("取消", gtk::ResponseType::Cancel),
            ("添加", gtk::ResponseType::Accept),
        ]);
        chooser.set_default_response(gtk::ResponseType::Accept);
        chooser.connect_response(move |chooser, response| {
            if response == gtk::ResponseType::Accept {
                on_chosen(chooser.filenames());
            }
            chooser.close();
        });
        chooser.show();
    }

    pub fn paths(&self) -> Vec<PathBuf> {
        self.files.borrow().clone()
    }

    pub fn add(self: &Rc<Self>, paths: Vec<PathBuf>) -> Result<(), &'static str> {
        let mut files = self.paths();
        for path in paths {
            if !files.contains(&path) {
                files.push(path);
            }
        }
        if files.len() > MAX_FILES {
            return Err("每条消息最多添加 6 个附件。");
        }
        self.files.replace(files);
        self.render();
        Ok(())
    }

    pub fn paste_image(self: &Rc<Self>, image: &gdk_pixbuf::Pixbuf) -> Result<(), String> {
        if self.files.borrow().len() == MAX_FILES {
            return Err("每条消息最多添加 6 个附件。".into());
        }
        if i64::from(image.width()) * i64::from(image.height()) > 24_000_000 {
            return Err("剪贴板图片像素过多，请缩小后再粘贴。".into());
        }
        let data = image
            .save_to_bufferv("png", &[("compression", "3")])
            .map_err(|error| format!("无法编码剪贴板图片：{error}"))?;
        if data.len() > MAX_BYTES {
            return Err("剪贴板图片超过 16 MiB。".into());
        }
        let directory =
            std::env::temp_dir().join(format!("span-clipboard-{}", glib::uuid_string_random()));
        DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|error| format!("无法准备剪贴板图片：{error}"))?;
        let path = directory.join("剪贴板图片.png");
        let result = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .and_then(|mut file| file.write_all(&data));
        if let Err(error) = result {
            remove_pasted(&path);
            return Err(format!("无法暂存剪贴板图片：{error}"));
        }
        self.files.borrow_mut().push(path.clone());
        self.pasted.borrow_mut().push(path);
        self.render();
        Ok(())
    }

    pub fn finish_send(self: &Rc<Self>, remote: bool) {
        self.files.borrow_mut().clear();
        // The local App Server may still load accepted image paths after the response.
        let pasted = self.pasted.take();
        if remote {
            for path in &pasted {
                remove_pasted(path);
            }
        }
        self.render();
    }

    fn render(self: &Rc<Self>) {
        for child in self.chips.children() {
            self.chips.remove(&child);
        }
        let files = self.files.borrow();
        for path in files.iter() {
            let name = filename(path);
            let chip = gtk::Box::new(gtk::Orientation::Horizontal, 4);
            chip.style_context().add_class("agent-attachment");
            chip.add(&icons::widget(Icon::File, 13));
            let label = gtk::Label::new(Some(&name));
            label.set_ellipsize(pango::EllipsizeMode::Middle);
            label.set_max_width_chars(20);
            label.set_tooltip_text(Some(&name));
            chip.add(&label);
            let remove = gtk::Button::with_label("×");
            remove.style_context().add_class("quiet-button");
            remove.set_tooltip_text(Some(&format!("移除 {name}")));
            let weak = Rc::downgrade(self);
            let entry = path.clone();
            remove.connect_clicked(move |_| {
                if let Some(list) = weak.upgrade() {
                    list.files.borrow_mut().retain(|path| path != &entry);
                    let mut pasted = list.pasted.borrow_mut();
                    if let Some(index) = pasted.iter().position(|path| path == &entry) {
                        remove_pasted(&pasted.remove(index));
                    }
                    list.render();
                }
            });
            chip.add(&remove);
            self.chips.insert(&chip, -1);
            chip.show_all();
            if let Some(parent) = chip.parent() {
                parent.show();
            }
        }
        self.chips.set_visible(!files.is_empty());
    }
}

impl Drop for Attachments {
    fn drop(&mut self) {
        for path in self.pasted.get_mut() {
            remove_pasted(path);
        }
    }
}

fn remove_pasted(path: &Path) {
    let _ = fs::remove_file(path);
    if let Some(directory) = path.parent() {
        let _ = fs::remove_dir(directory);
    }
}

pub struct Prepared {
    entries: Vec<Entry>,
}

struct Entry {
    path: PathBuf,
    name: String,
    image: bool,
}

impl Prepared {
    pub fn empty() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn read(paths: Vec<PathBuf>, socket: Option<&Path>) -> Result<Self, String> {
        let mut entries = Vec::new();
        let mut files = Vec::new();
        let mut remaining = MAX_BYTES;
        for chosen in paths {
            let name = filename(&chosen);
            let path = std::fs::canonicalize(&chosen)
                .map_err(|error| format!("无法读取 {name}：{error}"))?;
            if !path.is_file() {
                return Err(format!("{name} 必须是普通文件。"));
            }
            let file = File::open(&path).map_err(|error| format!("无法打开 {name}：{error}"))?;
            let metadata = file
                .metadata()
                .map_err(|error| format!("无法读取 {name} 的大小：{error}"))?;
            if !metadata.is_file() {
                return Err(format!("{name} 必须是普通文件。"));
            }
            if metadata.len() > remaining as u64 {
                return Err("附件总大小不能超过 16 MiB。".into());
            }
            let image = if socket.is_some() {
                let mut data = Vec::new();
                file.take(remaining as u64 + 1)
                    .read_to_end(&mut data)
                    .map_err(|error| format!("无法读取 {name}：{error}"))?;
                if data.len() > remaining {
                    return Err("附件总大小不能超过 16 MiB。".into());
                }
                remaining -= data.len();
                let image = is_image(&data);
                files.push((name.clone(), data));
                image
            } else {
                if path.to_str().is_none() {
                    return Err(format!("{name} 的完整路径必须使用 UTF-8。"));
                }
                remaining -= metadata.len() as usize;
                let mut header = Vec::new();
                file.take(12)
                    .read_to_end(&mut header)
                    .map_err(|error| format!("无法读取 {name}：{error}"))?;
                is_image(&header)
            };
            entries.push(Entry { path, name, image });
        }
        if let Some(socket) = socket {
            for (entry, path) in entries
                .iter_mut()
                .zip(crate::sftp::upload_attachments(socket, &files)?)
            {
                entry.path = path;
            }
        }
        Ok(Self { entries })
    }

    pub fn input(&self, text: &str, images: bool) -> Vec<Value> {
        let mut input = Vec::new();
        let mut message = text.to_owned();
        let files: Vec<_> = self
            .entries
            .iter()
            .filter(|entry| !images || !entry.image)
            .collect();
        if !files.is_empty() {
            if !message.is_empty() {
                message.push_str("\n\n");
            }
            message.push_str("本条消息的附件路径（按需读取）：");
            for entry in files {
                message.push_str(&format!("\n- {}", json!(entry.path)));
            }
        }
        if !message.is_empty() {
            input.push(json!({"type":"text","text":message,"text_elements":[]}));
        }
        if images {
            input.extend(
                self.entries
                    .iter()
                    .filter(|entry| entry.image)
                    .map(|entry| json!({"type":"localImage","path":entry.path})),
            );
        }
        input
    }

    pub fn summary(&self, text: &str) -> String {
        if self.entries.is_empty() {
            return text.to_owned();
        }
        let names = self
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>()
            .join(" · ");
        if text.is_empty() {
            format!("附件 · {names}")
        } else {
            format!("{text}\n\n附件 · {names}")
        }
    }
}

pub fn filename(path: &Path) -> String {
    let mut result = String::new();
    for character in path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
    {
        if result.len() + character.len_utf8() > 180 {
            break;
        }
        result.push(if character.is_control() {
            '_'
        } else {
            character
        });
    }
    if result.is_empty() {
        "附件".into()
    } else {
        result
    }
}

fn is_image(data: &[u8]) -> bool {
    data.starts_with(b"\x89PNG\r\n\x1a\n")
        || data.starts_with(b"\xff\xd8\xff")
        || data.starts_with(b"GIF87a")
        || data.starts_with(b"GIF89a")
        || (data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP"))
}
