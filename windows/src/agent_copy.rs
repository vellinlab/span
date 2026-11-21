use crate::clipboard_markup;
use clipboard_win::{Clipboard, formats, options::NoClear, raw};
use iced::window::raw_window_handle::RawWindowHandle;
use iced::{Task, window};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Markdown,
    RichText,
}

pub(super) fn write(markdown: String, format: Format) -> Task<Result<(), String>> {
    let prepared = match format {
        Format::Markdown => Task::done(Ok((markdown, None))),
        Format::RichText => Task::future(async {
            tokio::task::spawn_blocking(move || {
                let mut html = String::from("<div>");
                html.push_str(&clipboard_markup::rich_html(&markdown));
                html.push_str("</div>");
                (markdown, Some(html))
            })
            .await
            .map_err(|_| "Could not prepare formatted text.".to_string())
        }),
    };
    prepared.then(|prepared| match prepared {
        Ok(contents) => {
            // `latest` yields a single window ID. Transfer the payload without copying it.
            let mut contents = Some(contents);
            window::latest().then(move |id| {
                let Some((markdown, rich)) = contents.take() else {
                    return Task::none();
                };
                let Some(id) = id else {
                    return Task::done(Err("The Span window is no longer available.".into()));
                };
                // Keep the native window handle and clipboard ownership on the UI thread.
                window::run(id, move |window| {
                    write_clipboard(window, &markdown, rich.as_deref())
                })
            })
        }
        Err(error) => Task::done(Err(error)),
    })
}

fn write_clipboard(
    window: &dyn window::Window,
    markdown: &str,
    rich: Option<&str>,
) -> Result<(), String> {
    let handle = window.window_handle().map_err(|error| error.to_string())?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("The Windows clipboard is unavailable.".into());
    };
    let html_format = rich
        .map(|html| {
            formats::Html::new()
                .map(|format| (format, html))
                .ok_or("Could not register the Windows HTML clipboard format.")
        })
        .transpose()?;
    let _clipboard = Clipboard::new_attempts_for(handle.hwnd.get() as _, 2)
        .map_err(|error| format!("Could not open the clipboard: {error}"))?;
    raw::empty().map_err(|error| format!("Could not clear the clipboard: {error}"))?;
    if let Some((format, html)) = html_format {
        raw::set_html(format.code(), html)
            .map_err(|error| format!("Could not copy formatted text: {error}"))?;
    }
    raw::set_string_with(markdown, NoClear).map_err(|error| format!("Could not copy text: {error}"))
}
