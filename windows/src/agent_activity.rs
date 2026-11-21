use super::{Action, Activity, Item};
use crate::theme;
use crate::unified_diff::{self, Kind};
use iced::widget::{button, column, container, markdown, row, rule, scrollable, svg, text};
use iced::{Center, Color, Element, Fill, Font, Theme};

const MONOSPACE: Font = Font::with_name("Consolas");
const MAX_PREVIEW_LINES: usize = 160;
const MAX_PREVIEW_BYTES: usize = 16 * 1024;

pub(super) fn view<'a>(item: &'a Item, kind: Activity, theme: &'a Theme) -> Element<'a, Action> {
    let title = if item.title.is_empty() {
        "Run command"
    } else {
        &item.title
    };
    let toggle = button(
        row![
            svg(kind.icon())
                .width(14)
                .height(14)
                .style(|_, _| svg::Style {
                    color: Some(theme::MUTED),
                }),
            text(title).color(theme::MUTED).size(13).width(Fill),
            // The arrow inherits the button's foreground. Its slot stays fixed on hover.
            text(if item.expanded { "⌄" } else { "›" })
                .size(15)
                .center()
                .width(12),
        ]
        .spacing(8)
        .align_y(Center),
    )
    .on_press(Action::Toggle(item.id.clone()))
    .width(Fill)
    .padding([4, 8])
    .style(|_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        let mut style = theme::tab(false, status);
        style.background = hovered.then(|| theme::INK.scale_alpha(0.055).into());
        style.text_color = if hovered {
            theme::INK
        } else {
            Color::TRANSPARENT
        };
        style.snap = true;
        style
    });
    if !item.expanded {
        return toggle.into();
    }
    let detail = match kind {
        Activity::Reasoning => item.parsed.as_ref().map_or_else(
            || text(&item.value).size(14).into(),
            |document| {
                markdown::view(
                    document.items(),
                    markdown::Settings::with_text_size(14, theme),
                )
                .map(Action::Link)
            },
        ),
        Activity::Command | Activity::Changes => output_card(item, kind),
    };
    let indent = container(
        row![
            rule::vertical(1).style(theme::rule),
            container(detail).width(Fill)
        ]
        .spacing(12),
    )
    .padding([3, 15]);
    column![toggle, indent].spacing(4).into()
}

fn output_card<'a>(item: &'a Item, kind: Activity) -> Element<'a, Action> {
    let is_diff = matches!(kind, Activity::Changes);
    let source = &item.value;
    let bytes = source.floor_char_boundary(source.len().min(MAX_PREVIEW_BYTES));
    let length: usize = source[..bytes]
        .split_inclusive('\n')
        .take(MAX_PREVIEW_LINES)
        .map(str::len)
        .sum();
    let preview = &source[..length];
    let label = if is_diff { "Diff" } else { "Command output" };
    let body: Element<'_, Action> = if is_diff {
        diff_view(preview)
    } else {
        container(
            text(if preview.is_empty() {
                "No output yet"
            } else {
                preview
            })
            .font(MONOSPACE)
            .size(13)
            .wrapping(text::Wrapping::WordOrGlyph),
        )
        .padding([7, 10])
        .into()
    };
    let copy = button(text("Copy").size(12))
        .on_press_maybe((!source.is_empty()).then(|| Action::CopyActivity(item.id.clone())))
        .style(|_, status| theme::tab(false, status))
        .padding([4, 8]);
    let header =
        container(row![text(label).size(12).color(theme::MUTED).width(Fill), copy].align_y(Center))
            .padding([3, 6]);
    let mut card = column![
        header,
        rule::horizontal(1).style(theme::rule),
        container(scrollable(body)).max_height(252),
    ];
    if preview.len() < source.len() {
        card = card.push(
            container(
                text("Preview · use Copy for the full text")
                    .size(12)
                    .color(theme::MUTED),
            )
            .padding([5, 10]),
        );
    }
    container(card)
        .width(Fill)
        .style(|_| theme::panel(theme::INSET, 8.0))
        .clip(true)
        .into()
}

fn diff_view(source: &str) -> Element<'_, Action> {
    let mut lines = column![].width(Fill);
    for line in unified_diff::lines(source) {
        let (ink, background) = match line.kind {
            Kind::Added => (theme::GREEN, theme::hex(0x20382e)),
            Kind::Removed => (theme::ERROR, theme::hex(0x402930)),
            Kind::Header => (theme::MUTED, theme::INSET),
            Kind::Context => (theme::INK, theme::INSET),
        };
        let numbers =
            [line.old, line.new].map(|number| number.map_or_else(String::new, |n| n.to_string()));
        let gutter = row(numbers.into_iter().map(|number| {
            text(number)
                .font(MONOSPACE)
                .size(12)
                .width(42)
                .align_x(iced::Right)
                .color(theme::MUTED)
                .into()
        }))
        .spacing(4);
        lines = lines.push(
            container(
                row![
                    gutter,
                    text(line.text.trim_end_matches(['\r', '\n']))
                        .font(MONOSPACE)
                        .size(13)
                        .color(ink)
                        .width(Fill)
                        .wrapping(text::Wrapping::WordOrGlyph)
                ]
                .spacing(12),
            )
            .width(Fill)
            .padding([1, 10])
            .style(move |_| theme::surface(background)),
        );
    }
    lines.into()
}
