use crate::Message;
use iced::widget::{
    button, container, overlay::menu, pick_list, rule, svg, text, text_editor, tooltip,
};
use iced::{Background, Border, Color, Element, Fill, Font, Shadow, Theme, Vector, font, theme};
use std::sync::OnceLock;

pub const CHROME: Color = hex(0x1b202a);
pub const SIDE: Color = hex(0x131820);
pub const WORK: Color = hex(0x171b24);
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

pub fn editor(_: &Theme, _: text_editor::Status) -> text_editor::Style {
    text_editor::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: Border::default(),
        placeholder: MUTED,
        value: INK,
        selection: hex(0x394d76),
    }
}

pub fn choice(_: &Theme, status: pick_list::Status) -> pick_list::Style {
    let active = !matches!(status, pick_list::Status::Active);
    pick_list::Style {
        text_color: INK,
        placeholder_color: MUTED,
        handle_color: MUTED,
        background: if active {
            HIGHLIGHT
        } else {
            Color::TRANSPARENT
        }
        .into(),
        border: Border::default().rounded(7),
    }
}

pub fn choice_menu(_: &Theme) -> menu::Style {
    menu::Style {
        background: hex(0x232b39).into(),
        border: Border::default().color(LINE).width(1).rounded(9),
        text_color: INK,
        selected_text_color: INK,
        selected_background: hex(0x354364).into(),
        shadow: Shadow {
            color: Color::BLACK.scale_alpha(0.3),
            offset: Vector::new(0.0, 4.0),
            blur_radius: 12.0,
        },
    }
}

pub fn hint<'a, Message: 'a>(label: impl Into<String>) -> Element<'a, Message> {
    container(text(label.into()).size(12))
        .padding([6, 8])
        .style(|_| panel(CHROME, 7.0))
        .into()
}

#[derive(Clone, Copy)]
pub enum ComposerIcon {
    Attach,
    Fast(bool),
    Stop,
    Send,
}

impl ComposerIcon {
    pub fn button<'a, Message: Clone + 'a>(
        self,
        label: &'static str,
        message: Option<Message>,
    ) -> Element<'a, Message> {
        static ATTACH: OnceLock<svg::Handle> = OnceLock::new();
        static FAST: OnceLock<svg::Handle> = OnceLock::new();
        static STOP: OnceLock<svg::Handle> = OnceLock::new();
        static SEND: OnceLock<svg::Handle> = OnceLock::new();
        let (handle, shape) = match self {
            Self::Attach => (
                &ATTACH,
                r#"<path d="m20 11-7.5 7.5a4.2 4.2 0 0 1-6-6l8.2-8.2a2.8 2.8 0 0 1 4 4l-8.3 8.3a1.35 1.35 0 0 1-1.9-1.9l7.3-7.3"/>"#,
            ),
            Self::Fast(_) => (&FAST, r#"<path d="m13 2-8 11h6l-1 9 9-12h-6l1-8z"/>"#),
            Self::Stop => (
                &STOP,
                r#"<rect x="6" y="6" width="12" height="12" rx="2" fill="white"/>"#,
            ),
            Self::Send => (&SEND, r#"<path d="M12 19V5m-5 5 5-5 5 5"/>"#),
        };
        let handle = handle.get_or_init(|| svg::Handle::from_memory(format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{shape}</g></svg>"#
        ).into_bytes()));
        let enabled = message.is_some();
        let color = match self {
            Self::Send if enabled => INSET,
            Self::Fast(true) => BLUE,
            _ if !enabled => MUTED.scale_alpha(0.72),
            Self::Fast(false) | Self::Attach => MUTED,
            _ => INK,
        };
        let button = button(
            svg(handle.clone())
                .width(16)
                .height(16)
                .style(move |_, _| svg::Style { color: Some(color) }),
        )
        .on_press_maybe(message)
        .padding(7)
        .style(move |_, status| {
            let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
            let (background, border, radius) = match self {
                Self::Send if enabled => (
                    if hovered { hex(0xc5d3ff) } else { BLUE },
                    Color::TRANSPARENT,
                    16.0,
                ),
                Self::Stop | Self::Send => (if hovered { HIGHLIGHT } else { WORK }, LINE, 16.0),
                Self::Attach | Self::Fast(false) => (
                    if hovered {
                        HIGHLIGHT
                    } else {
                        Color::TRANSPARENT
                    },
                    Color::TRANSPARENT,
                    7.0,
                ),
                Self::Fast(true) => (
                    if hovered { hex(0x354364) } else { HIGHLIGHT },
                    Color::TRANSPARENT,
                    7.0,
                ),
            };
            button::Style {
                background: Some(background.into()),
                border: Border::default().color(border).width(1).rounded(radius),
                ..button::Style::default()
            }
        });
        tooltip(button, hint(label), tooltip::Position::Top).into()
    }
}

pub fn context_usage<'a, Message: 'a>(used: u64, limit: u64) -> Element<'a, Message> {
    use std::fmt::Write;

    static RINGS: [OnceLock<svg::Handle>; 101] = [const { OnceLock::new() }; 101];
    let percent = (100.0 * used as f64 / limit as f64)
        .clamp(0.0, 100.0)
        .round() as usize;
    let ring = RINGS[percent].get_or_init(|| {
        let mut graphic = String::from(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="#465167" stroke-width="2.5"/>"##,
        );
        if percent > 0 {
            let progress = std::f64::consts::TAU * 8.0 * percent as f64 / 100.0;
            let color = if percent >= 90 { "#e7bf80" } else { "#a5bbff" };
            write!(graphic, r#"<circle cx="12" cy="12" r="8" fill="none" stroke="{color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="{progress} 51" transform="rotate(-90 12 12)"/>"#).expect("write context gauge SVG");
        }
        graphic.push_str("</svg>");
        svg::Handle::from_memory(graphic.into_bytes())
    });
    tooltip(
        svg(ring.clone()).width(21).height(21),
        hint(format!(
            "Context window · {percent}% used\n{used} of {limit} tokens"
        )),
        tooltip::Position::Top,
    )
    .into()
}

pub fn action<'a>(label: &'a str, message: Message, accent: bool) -> button::Button<'a, Message> {
    button(text(label).size(14))
        .on_press(message)
        .padding([7, 12])
        .style(move |_, status| button_status(accent, status))
}

pub fn mode(
    label: &'static str,
    message: Message,
    selected: bool,
) -> button::Button<'static, Message> {
    button(text(label).size(14))
        .on_press(message)
        .padding([6, 13])
        .style(move |_, status| tab(selected, status))
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
        background: (hover || selected).then_some(Background::Color(if hover {
            HIGHLIGHT
        } else {
            hex(0x242d3e)
        })),
        text_color: if hover || selected { INK } else { MUTED },
        border: Border::default().rounded(7),
        ..button::Style::default()
    }
}
