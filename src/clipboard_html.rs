use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, html};

pub(crate) fn web_url(uri: &str) -> bool {
    uri.split_once("://").is_some_and(|(scheme, rest)| {
        (scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http"))
            && !rest.is_empty()
            && !rest.chars().any(char::is_whitespace)
            && !rest.chars().any(char::is_control)
    })
}

pub(crate) fn rich_html(markdown: &str) -> String {
    let mut formatted = String::new();
    let mut link = false;
    html::push_html(
        &mut formatted,
        Parser::new_ext(
            markdown,
            Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH,
        )
        .filter_map(|event| match event {
            Event::Html(text) | Event::InlineHtml(text) => Some(Event::Text(text)),
            Event::Start(Tag::Link { ref dest_url, .. }) => {
                link = web_url(dest_url);
                link.then_some(event)
            }
            Event::End(TagEnd::Link) => std::mem::take(&mut link).then_some(event),
            Event::Start(Tag::Image { .. }) | Event::End(TagEnd::Image) => None,
            event => Some(event),
        }),
    );
    formatted
}
