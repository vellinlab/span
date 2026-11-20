use gtk::prelude::*;
use gtk::{gdk_pixbuf::Pixbuf, gio, glib};
use std::cell::Cell;

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
    let stream = gio::File::for_uri(&uri)
        .read_future(glib::Priority::LOW)
        .await
        .ok()?;
    let mut bytes = Vec::new();
    while bytes.len() <= MAX_LOGO {
        let chunk = stream
            .read_bytes_future(8192, glib::Priority::LOW)
            .await
            .ok()?;
        if chunk.is_empty() {
            return pixbuf(bytes);
        }
        bytes.extend_from_slice(&chunk);
    }
    None
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
            let weak = tile.downgrade();
            let uri = uri.clone();
            glib::MainContext::default().spawn_local(async move {
                if let Some(image) = logo(uri).await
                    && let Some(tile) = weak.upgrade()
                {
                    let image = gtk::Image::from_pixbuf(Some(&image));
                    tile.add_named(&image, "catalog");
                    image.show();
                    tile.set_visible_child(&image);
                }
            });
        });
    }
    tile
}
