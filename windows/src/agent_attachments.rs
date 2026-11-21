use base64::{Engine as _, engine::general_purpose::STANDARD};
use clipboard_win::{Clipboard, formats, raw};
use iced::widget::image::Handle;
use image::{
    DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, codecs::bmp::BmpDecoder,
    codecs::png::PngEncoder,
};
use std::{
    fmt,
    fs::File,
    io::{Cursor, Read},
    sync::Arc,
};

pub const MAX_IMAGES: usize = 4;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_PIXELS: u64 = 16_000_000;
const MAX_BITMAP_BYTES: usize = (MAX_PIXELS as usize * 4) + 4096;

#[derive(Clone)]
pub struct Attachment {
    pub name: Arc<str>,
    pub url: Arc<String>,
    pub thumbnail: Handle,
    pub bytes: usize,
}

impl fmt::Debug for Attachment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Attachment")
            .field("name", &self.name)
            .field("bytes", &self.bytes)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub enum Prepared {
    Text(String),
    Image(Attachment),
}

pub fn from_clipboard() -> Result<Option<Prepared>, String> {
    let clipboard =
        Clipboard::new_attempts(10).map_err(|_| "Could not open the Windows clipboard.")?;
    if let Some(markdown) = crate::clipboard_markup::from_open_windows(&clipboard) {
        return Ok(Some(Prepared::Text(markdown)));
    }

    let png = raw::register_format("PNG").map(|code| (code.get(), MAX_BYTES, false));
    let candidates = png.into_iter().chain([
        (formats::CF_DIBV5, MAX_BITMAP_BYTES, true),
        (formats::CF_DIB, MAX_BITMAP_BYTES, true),
    ]);
    for (format, limit, dib) in candidates {
        if let Some(size) = raw::size(format) {
            if size.get() > limit {
                return Err("The clipboard image is too large to attach.".into());
            }
            let bytes = clipboard_win::get(formats::RawData(format))
                .map_err(|_| "Could not read the clipboard image.")?;
            drop(clipboard);
            return if dib {
                from_dib(bytes)
            } else {
                from_image("Screenshot.png".into(), bytes)
            }
            .map(|image| Some(Prepared::Image(image)));
        }
    }

    let text = clipboard_win::get(formats::Unicode).ok();
    Ok(text.map(Prepared::Text))
}

pub fn pick_file() -> Result<Option<Prepared>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("PNG and JPEG images", &["png", "jpg", "jpeg"])
        .pick_file()
    else {
        return Ok(None);
    };
    let file = File::open(&path).map_err(|error| format!("Could not open the image. {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not read the image size. {error}"))?;
    if !metadata.is_file() {
        return Err("Select an image file.".into());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err("Image attachments are limited to 8 MiB.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read the image. {error}"))?;
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .take(100)
        .collect::<String>();
    from_image(name.into(), bytes).map(|image| Some(Prepared::Image(image)))
}

fn from_image(name: Arc<str>, bytes: Vec<u8>) -> Result<Attachment, String> {
    check_bytes(&bytes)?;
    let format = image::guess_format(&bytes).map_err(|_| "Select a PNG or JPEG image.")?;
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        _ => return Err("Select a PNG or JPEG image.".into()),
    };
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(MAX_PIXELS * 4);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|_| "Could not read the image.")?;
    let thumbnail = thumbnail(decode(decoder)?);
    Ok(attachment(name, mime, bytes, thumbnail))
}

fn from_dib(bytes: Vec<u8>) -> Result<Attachment, String> {
    let decoder = BmpDecoder::new_without_file_header(Cursor::new(bytes))
        .map_err(|_| "Could not read the clipboard bitmap.")?;
    let image = decode(decoder)?;
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
        .map_err(|_| "Could not encode the clipboard bitmap.")?;
    check_bytes(&bytes)?;
    Ok(attachment(
        "Screenshot.png".into(),
        "image/png",
        bytes,
        thumbnail(image),
    ))
}

fn check_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BYTES {
        return Err("Image attachments are limited to 8 MiB.".into());
    }
    Ok(())
}

fn decode(decoder: impl ImageDecoder) -> Result<DynamicImage, String> {
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS || decoder.total_bytes() > MAX_PIXELS * 4 {
        return Err("Image attachments are limited to 16 megapixels.".into());
    }
    DynamicImage::from_decoder(decoder).map_err(|_| "Could not decode the image.".into())
}

fn thumbnail(image: DynamicImage) -> Handle {
    let thumbnail = image.thumbnail(56, 40).into_rgba8();
    Handle::from_rgba(thumbnail.width(), thumbnail.height(), thumbnail.into_raw())
}

fn attachment(name: Arc<str>, mime: &str, bytes: Vec<u8>, thumbnail: Handle) -> Attachment {
    let mut url = format!("data:{mime};base64,");
    url.reserve(bytes.len().div_ceil(3) * 4);
    STANDARD.encode_string(&bytes, &mut url);
    Attachment {
        name,
        url: Arc::new(url),
        thumbnail,
        bytes: bytes.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitmap_is_converted_to_an_inline_png() {
        let mut bitmap = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(7, 3)
            .write_to(&mut bitmap, ImageFormat::Bmp)
            .expect("generate bitmap");
        let attachment = from_dib(bitmap.into_inner()[14..].to_vec()).expect("decode DIB");
        let png = STANDARD
            .decode(
                attachment
                    .url
                    .strip_prefix("data:image/png;base64,")
                    .unwrap(),
            )
            .expect("decode inline attachment");
        assert_eq!(png.len(), attachment.bytes);
        assert_eq!(image::load_from_memory(&png).unwrap().width(), 7);
    }
}
