use crate::Message;
use iced::widget::{button, container, rule, text};
use iced::{Background, Border, Color, Fill, Font, Theme, font, theme};

pub const CHROME: Color = hex(0x141a25);
pub const SIDE: Color = hex(0x151a23);
pub const WORK: Color = hex(0x1a1e28);
pub const INSET: Color = hex(0x111620);
pub const TERMINAL: Color = hex(crate::terminal_theme::BACKGROUND);
pub const LINE: Color = hex(0x2b3444);
pub const INK: Color = hex(0xe9edf5);
pub const MUTED: Color = hex(0xa2adbf);
pub const BLUE: Color = hex(0xa5bbff);
pub const GREEN: Color = hex(0x86d8b5);
pub const ERROR: Color = hex(0xf79ba4);
pub const HIGHLIGHT: Color = hex(0x29354d);

pub const SEMIBOLD: Font = Font {
    weight: font::Weight::Semibold,
    ..Font::with_name("Segoe UI")
};

pub const fn hex(rgb: u32) -> Color {
    Color {
        r: ((rgb >> 16) as u8) as f32 / 255.0,
        g: ((rgb >> 8) as u8) as f32 / 255.0,
        b: (rgb as u8) as f32 / 255.0,
        a: 1.0,
    }
}

pub fn make() -> Theme {
    Theme::custom(
        "Span",
        theme::Palette {
            background: WORK,
            text: INK,
            primary: BLUE,
            success: GREEN,
            warning: hex(0xe7bf80),
            danger: ERROR,
        },
    )
}

pub fn surface(color: Color) -> container::Style {
    container::Style::default().background(color)
}

pub fn rounded(color: Color, radius: f32) -> container::Style {
    surface(color).border(Border::default().rounded(radius))
}

pub fn panel(color: Color, radius: f32) -> container::Style {
    surface(color).border(Border::default().color(LINE).width(1).rounded(radius))
}

pub fn rule(theme: &Theme) -> rule::Style {
    rule::Style {
        color: LINE,
        ..rule::default(theme)
    }
}

pub fn action<'a>(label: &'a str, message: Message, accent: bool) -> button::Button<'a, Message> {
    button(text(label).size(14))
        .on_press(message)
        .padding([7, 12])
        .style(move |_, status| button_status(accent, status))
}

pub fn nav<'a>(label: &'a str, message: Message, selected: bool) -> button::Button<'a, Message> {
    button(text(label).size(14))
        .on_press(message)
        .width(Fill)
        .padding([9, 11])
        .style(move |_, status| tab(selected, status))
}

pub fn button_status(accent: bool, status: button::Status) -> button::Style {
    use button::Status::*;
    let (background, text_color) = match (accent, status) {
        (_, Disabled) => (INSET, MUTED),
        (true, Hovered) => (hex(0xc1d0ff), INSET),
        (true, Pressed) => (hex(0x8aabfb), INSET),
        (true, Active) => (BLUE, INSET),
        (false, Hovered | Pressed) => (HIGHLIGHT, INK),
        (false, Active) => (WORK, INK),
    };
    button::Style {
        background: Some(Background::Color(background)),
        text_color,
        border: Border::default()
            .color(if accent { background } else { LINE })
            .width(1)
            .rounded(8),
        ..button::Style::default()
    }
}

pub fn tab(selected: bool, status: button::Status) -> button::Style {
    let hover = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: hover.then_some(Background::Color(HIGHLIGHT)),
        text_color: if hover || selected { INK } else { MUTED },
        border: Border::default().rounded(7),
        ..button::Style::default()
    }
}
