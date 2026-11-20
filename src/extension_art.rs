use futures_channel::mpsc;
use futures_util::StreamExt;
use gtk::prelude::*;
use gtk::{gdk_pixbuf::Pixbuf, gio, glib};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::io::Read;
use std::process::{Command, Stdio};
use std::rc::Rc;

const MAX_LOGO: usize = 160 * 1024;

pub fn usable_reference(uri: &str) -> bool {
    (uri.starts_with("https://") && uri.len() <= 2048)
        || (uri.len() <= MAX_LOGO
            && [
                "data:image/png;base64,",
                "data:image/jpeg;base64,",
                "data:image/svg+xml;base64,",
            ]
            .iter()
            .any(|prefix| uri.starts_with(prefix)))
}

pub fn reference<'a>(object: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| object[*key].as_str().filter(|s| usable_reference(s)))
}

fn pixbuf(bytes: Vec<u8>) -> Option<Pixbuf> {
    let stream = gio::MemoryInputStream::from_bytes(&glib::Bytes::from_owned(bytes));
    Pixbuf::from_stream_at_scale(&stream, 28, 28, true, gio::Cancellable::NONE).ok()
}

async fn logo(uri: String) -> Option<Pixbuf> {
    if let Some((_, data)) = uri
        .strip_prefix("data:")
        .and_then(|uri| uri.split_once(','))
    {
        return pixbuf(glib::base64_decode(data).to_vec());
    }
    gio::spawn_blocking(move || fetch(&uri))
        .await
        .ok()
        .flatten()
        .and_then(pixbuf)
}

// GTK installations without GVfs (including the portable Windows build) need
// an HTTPS transport. curl is optional; the tile already has an offline image.
fn fetch(uri: &str) -> Option<Vec<u8>> {
    let mut command = Command::new("curl");
    if crate::heap::has_private_allocator() {
        for variable in crate::heap::PRIVATE_ENVIRONMENT {
            command.env_remove(variable);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .args([
            "-q",
            "--silent",
            "--fail",
            "--location",
            "--max-redirs",
            "3",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "3",
            "--max-time",
            "6",
            "--max-filesize",
            "163840",
            "--",
            uri,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()?
        .take((MAX_LOGO + 1) as u64)
        .read_to_end(&mut bytes);
    if read.is_err() || bytes.len() > MAX_LOGO {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    child.wait().ok()?.success().then_some(bytes)
}

type TileRequest = (String, glib::WeakRef<gtk::Stack>);
thread_local! {
    static LOGOS: mpsc::UnboundedSender<TileRequest> = {
        let (send, pending) = mpsc::unbounded::<TileRequest>();
        let cache = Rc::new(RefCell::new(VecDeque::<(String, Pixbuf)>::new()));
        glib::MainContext::default().spawn_local(pending.for_each_concurrent(3, move |(uri, weak)| {
            let cache = cache.clone();
            async move {
                if weak.upgrade().is_none() { return; }
                let cached = cache.borrow().iter().find(|(key, _)| key == &uri).map(|(_, p)| p.clone());
                let image = if let Some(p) = cached { p } else {
                    let Some(p) = logo(uri.clone()).await else { return; };
                    if uri.starts_with("https://") {
                        let mut cache = cache.borrow_mut();
                        if cache.len() == 64 {cache.pop_front();}
                        cache.push_back((uri, p.clone()));
                    }
                    p
                };
                if let Some(tile) = weak.upgrade() {
                    let image = gtk::Image::from_pixbuf(Some(&image));
                    tile.add_named(&image, "catalog");
                    image.show();
                    tile.set_visible_child(&image);
                }
            }
        }));
        send
    };
}

pub fn tile(name: &str, uri: Option<&str>) -> gtk::Stack {
    let key = name.trim().to_ascii_lowercase();
    let built_in: Option<&[u8]> = match key.as_str() {
        "github" => Some(include_bytes!("art/github.svg")),
        "google drive" | "google-drive" => Some(include_bytes!("art/drive.svg")),
        "notion" => Some(include_bytes!("art/notion.png")),
        "pets" | "work pets" => Some(include_bytes!("art/pets.svg")),
        "chatgpt space" | "chatgpt spaces" => Some(include_bytes!("art/space.svg")),
        _ => None,
    };
    let tile = gtk::Stack::new();
    tile.set_size_request(38, 38);
    tile.set_valign(gtk::Align::Start);
    tile.set_halign(gtk::Align::Start);
    tile.style_context().add_class("extension-logo");
    let colors = ["iris", "sea", "amber", "rose"];
    let color = if matches!(key.as_str(), "github" | "notion" | "google drive") {
        "paper"
    } else if matches!(key.as_str(), "pets" | "work pets") {
        "lilac"
    } else {
        colors[key.bytes().map(usize::from).sum::<usize>() % colors.len()]
    };
    tile.style_context().add_class(color);
    if let Some(image) = built_in.and_then(|bytes| pixbuf(bytes.to_vec())) {
        tile.add_named(&gtk::Image::from_pixbuf(Some(&image)), "fallback");
    } else {
        let initials: String = name
            .split(|c: char| !c.is_alphanumeric())
            .filter_map(|word| word.chars().next())
            .take(2)
            .collect();
        let initials = if initials.is_empty() {
            "◇".into()
        } else {
            initials.to_uppercase()
        };
        tile.add_named(&gtk::Label::new(Some(&initials)), "fallback");
    }
    if let Some(uri) = uri {
        let uri = uri.to_owned();
        let started = Cell::new(false);
        tile.connect_map(move |tile| {
            if started.replace(true) {
                return;
            }
            LOGOS.with(|logos| {
                let _ = logos.unbounded_send((uri.clone(), tile.downgrade()));
            });
        });
    }
    tile
}
