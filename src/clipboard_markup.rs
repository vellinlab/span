#[path = "clipboard_html.rs"]
pub(crate) mod clipboard_html;
pub(crate) use clipboard_html::rich_html;

const MAX_HTML_BYTES: usize = 1024 * 1024;
const MAX_MARKDOWN_BYTES: usize = 256 * 1024;

pub fn to_markdown(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_HTML_BYTES {
        return None;
    }
    let html = std::str::from_utf8(bytes).ok()?.trim_matches('\0');
    let markdown = htmd::HtmlToMarkdown::builder()
        .skip_tags(vec![
            "head", "script", "style", "noscript", "iframe", "svg", "img", "template",
        ])
        .build()
        .convert(html)
        .ok()?;
    let markdown = markdown.trim();
    (!markdown.is_empty() && markdown.len() <= MAX_MARKDOWN_BYTES).then(|| markdown.to_owned())
}

#[cfg(windows)]
pub fn from_windows() -> Option<String> {
    let clipboard = clipboard_win::Clipboard::new_attempts(10).ok()?;
    from_open_windows(&clipboard)
}

#[cfg(windows)]
pub fn from_open_windows(_: &clipboard_win::Clipboard) -> Option<String> {
    let html = clipboard_win::formats::Html::new()?;
    if clipboard_win::raw::size(html.code())?.get() > MAX_HTML_BYTES {
        return None;
    }
    let bytes: Vec<u8> = clipboard_win::get(html).ok()?;
    to_markdown(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notion_paste_preserves_document_structure() {
        let html = r#"<html><head><title>Ignore this</title></head><body>
          <h2>发布计划</h2><p><strong>重要</strong> <a href="https://example.org/check">检查</a></p>
          <ul><li>输入与输出</li><li>验证</li></ul>
          <pre><code>let version = "rc";</code></pre>
          <table><thead><tr><th>环境</th><th>状态</th></tr></thead>
          <tbody><tr><td>EL8</td><td>通过</td></tr></tbody></table>
          <script>ignored()</script></body></html>"#;
        let markdown = to_markdown(html.as_bytes()).expect("convert the clipboard fragment");
        for text in [
            "## 发布计划",
            "**重要**",
            "[检查](https://example.org/check)",
            "输入与输出",
            "let version",
            "| 环境",
            "| EL8",
        ] {
            assert!(markdown.contains(text), "missing {text}: {markdown}");
        }
        assert!(!markdown.contains("ignored()"));
        assert!(!markdown.contains("Ignore this"));
    }

    #[test]
    fn image_only_and_invalid_html_fall_back_to_other_formats() {
        assert!(to_markdown(b"<img src='ignore.png'>").is_none());
        assert!(to_markdown(&[0xff]).is_none());
        assert!(to_markdown(&vec![b'a'; MAX_HTML_BYTES + 1]).is_none());
    }
}
