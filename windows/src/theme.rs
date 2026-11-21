use crate::Message;
use iced::widget::{
    button, column, container, markdown, overlay::menu, pick_list, rich_text, rule, scrollable,
    svg, text, text_editor, tooltip,
};
use iced::{Background, Border, Color, Element, Fill, Font, Shadow, Theme, Vector, font, theme};
use std::sync::OnceLock;

pub const CHROME: Color = hex(0x222223);
pub const SIDE: Color = hex(0x202020);
pub const WORK: Color = hex(0x1a1a19);
pub const INSET: Color = hex(0x151514);
pub const PANEL: Color = hex(0x252524);
pub const COMPOSER: Color = hex(0x2b2b29);
pub const TERMINAL: Color = hex(crate::terminal_theme::BACKGROUND);
pub const LINE: Color = hex(0x323231);
pub const INK: Color = hex(0xf0efec);
pub const MUTED: Color = hex(0xaaa9a4);
pub const ACTIVITY: Color = hex(0x989892);
pub const BLUE: Color = hex(0x8cbafb);
pub const GREEN: Color = hex(0x8ad4ae);
pub const ERROR: Color = hex(0xf49d9c);
pub const HIGHLIGHT: Color = hex(0x333331);
pub const SELECTED: Color = hex(0x303133);
pub const BUBBLE: Color = hex(0x2b3748);
const PRIMARY: Color = hex(0x2f65b6);
const PRIMARY_HOVER: Color = hex(0x3876cd);

pub const UI_FONT: Font = Font::with_name("Segoe UI");
pub const CODE_FONT: Font = Font::with_name("Consolas");
pub const BODY_SIZE: u32 = 15;
pub const BODY_LEADING: f32 = 1.48;
pub const SEMIBOLD: Font = Font {
    weight: font::Weight::Semibold,
    ..UI_FONT
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

pub fn composer() -> container::Style {
    surface(COMPOSER).border(Border::default().color(hex(0x3b3b38)).width(1).rounded(18))
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
        selection: hex(0x3c5374),
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
        background: PANEL.into(),
        border: Border::default().color(LINE).width(1).rounded(9),
        text_color: INK,
        selected_text_color: INK,
        selected_background: HIGHLIGHT.into(),
        shadow: Shadow {
            color: Color::BLACK.scale_alpha(0.3),
            offset: Vector::new(0.0, 4.0),
            blur_radius: 12.0,
        },
    }
}

pub fn reading_markdown<'a>(
    items: impl IntoIterator<Item = &'a markdown::Item>,
    size: u32,
    color: Color,
    theme: &Theme,
) -> Element<'a, markdown::Uri> {
    let mut style = markdown::Style::from(theme);
    style.font = UI_FONT;
    style.inline_code_font = CODE_FONT;
    style.code_block_font = CODE_FONT;
    style.inline_code_highlight.background = hex(0x373735).into();
    style.inline_code_color = INK;
    let mut settings = markdown::Settings::with_text_size(size, style);
    settings.h1_size = 24.0.into();
    settings.h2_size = 21.0.into();
    settings.h3_size = 18.0.into();
    settings.h4_size = 16.0.into();
    settings.code_size = 13.0.into();
    settings.spacing = 11.0.into();
    let content = markdown::view_with(items, settings, &ReadingMarkdown);
    if color == INK {
        content
    } else {
        container(content)
            .style(move |_| container::Style::default().color(color))
            .into()
    }
}

struct ReadingMarkdown;

impl<'a> markdown::Viewer<'a, markdown::Uri> for ReadingMarkdown {
    fn on_link_click(url: markdown::Uri) -> markdown::Uri {
        url
    }

    fn paragraph(
        &self,
        settings: markdown::Settings,
        text: &markdown::Text,
    ) -> Element<'a, markdown::Uri> {
        rich_text(text.spans(settings.style))
            .size(settings.text_size)
            .line_height(BODY_LEADING)
            .on_link_click(Self::on_link_click)
            .into()
    }

    fn code_block(
        &self,
        settings: markdown::Settings,
        language: Option<&'a str>,
        _code: &'a str,
        lines: &'a [markdown::Text],
    ) -> Element<'a, markdown::Uri> {
        let mut code = column![].width(Fill);
        if let Some(language) = language.filter(|language| !language.is_empty()) {
            code = code.push(
                container(text(language).size(12).font(SEMIBOLD).color(MUTED))
                    .padding([7, 12])
                    .width(Fill)
                    .style(|_| surface(PANEL)),
            );
        }
        let mut style = settings.style;
        style.font = CODE_FONT;
        let lines = column(lines.iter().map(|line| {
            rich_text(line.spans(style))
                .font(CODE_FONT)
                .size(settings.code_size)
                .line_height(1.4)
                .wrapping(text::Wrapping::None)
                .on_link_click(Self::on_link_click)
                .into()
        }));
        container(
            code.push(
                scrollable(container(lines).padding([10, 12]))
                    .width(Fill)
                    .direction(scrollable::Direction::Horizontal(
                        scrollable::Scrollbar::new().width(6).scroller_width(4),
                    )),
            ),
        )
        .width(Fill)
        .clip(true)
        .style(|_| panel(INSET, 9.0))
        .into()
    }
}

pub fn hint<'a, Message: 'a>(label: impl Into<String>) -> Element<'a, Message> {
    container(text(label.into()).size(12))
        .padding([6, 8])
        .style(|_| panel(CHROME, 7.0))
        .into()
}

#[derive(Clone, Copy)]
pub enum WorkspaceIcon {
    Sidebar,
    Terminal,
    Connect,
    Conversation,
    Remote,
    Drawer,
    Plus,
    Close,
    More,
    Import,
}

impl WorkspaceIcon {
    fn handle(self) -> svg::Handle {
        static GLYPHS: [OnceLock<svg::Handle>; 10] = [const { OnceLock::new() }; 10];
        let path = match self {
            Self::Sidebar => {
                "M14 14H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 4h12a1.5 1.5 0 0 1 1.5 1.5V9M7 18h4m8-5.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8m-1 2.5 1.5 1.5-1.5 1.5"
            }
            Self::Terminal => {
                "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm3 4 3 3-3 3m6 0h4"
            }
            Self::Connect => {
                "M4 5h12a1 1 0 0 1 1 1v4M4 5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h5m-2 3h3m8-7v8m-4-4h8"
            }
            Self::Conversation => {
                "M6 4h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-7l-5 4v-4a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm2 6h8m-8 3h5"
            }
            Self::Remote => {
                "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm4 15h8M8 10h8m-2-2 2 2-2 2M8 13h4"
            }
            Self::Drawer => {
                "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 10h16m-13 2 1.5 1.5L7 19m4-1h3"
            }
            Self::Plus => "M12 5v14M5 12h14",
            Self::Close => "m6 6 12 12m0-12L6 18",
            Self::More => "M5 12h.5m6 0h.5m6 0h.5",
            Self::Import => "M12 3v11m-4-4 4 4 4-4M4 16v4h16v-4",
        };
        GLYPHS[self as usize].get_or_init(|| svg::Handle::from_memory(format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="{path}" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>"#
        ).into_bytes())).clone()
    }

    pub fn glyph<'a>(self, size: u32, color: Color) -> svg::Svg<'a, Theme> {
        svg(self.handle())
            .width(size)
            .height(size)
            .style(move |_, _| svg::Style { color: Some(color) })
    }

    pub fn control<'a, Message: Clone + 'a>(
        self,
        label: &'static str,
        message: Option<Message>,
        active: bool,
    ) -> Element<'a, Message> {
        let color = if message.is_none() {
            MUTED.scale_alpha(0.5)
        } else if active {
            BLUE
        } else {
            MUTED
        };
        let control = button(self.glyph(17, color))
            .on_press_maybe(message)
            .padding(6)
            .style(move |_, status| tab(active, status));
        tooltip(control, hint(label), tooltip::Position::FollowCursor).into()
    }
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
            Self::Send if enabled => Color::WHITE,
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
                    if hovered { PRIMARY_HOVER } else { PRIMARY },
                    Color::TRANSPARENT,
                    16.0,
                ),
                Self::Stop => (
                    if hovered { PRIMARY_HOVER } else { PRIMARY },
                    Color::TRANSPARENT,
                    16.0,
                ),
                Self::Send => (COMPOSER, hex(0x4a4a46), 16.0),
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
                    if hovered { BUBBLE } else { HIGHLIGHT },
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
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="#545450" stroke-width="2.5"/>"##,
        );
        if percent > 0 {
            let progress = std::f64::consts::TAU * 8.0 * percent as f64 / 100.0;
            let color = if percent >= 90 { "#e7bf80" } else { "#d5d4ce" };
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
    button(
        text(label)
            .size(13)
            .shaping(text::Shaping::Advanced)
            .center(),
    )
    .on_press(message)
    .padding([6, 6])
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
        (true, Hovered) => (PRIMARY_HOVER, Color::WHITE),
        (true, Pressed) => (hex(0x275798), Color::WHITE),
        (true, Active) => (PRIMARY, Color::WHITE),
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
            SELECTED
        })),
        text_color: if hover || selected { INK } else { MUTED },
        border: Border::default().rounded(7),
        ..button::Style::default()
    }
}
