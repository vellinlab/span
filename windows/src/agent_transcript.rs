use super::{Action, CopyFormat, Item, Kind, activity, agent_scroll::ReadingPosition};
use crate::theme;
use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout, mouse, overlay, renderer,
    widget::{Operation, Tree, tree},
};
use iced::widget::{button, column, container, row, svg, text, tooltip};
use iced::{Element, Event, Fill, Length, Point, Rectangle, Renderer, Right, Size, Theme, Vector};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ops::Range;
use std::sync::OnceLock;

const SPACING: f32 = 14.0;
const OVERSCAN: f32 = 160.0;

#[derive(Clone, Copy)]
pub(super) struct Measurement {
    limits: layout::Limits,
    has_copy: bool,
    size: Size,
}

struct Row<'a> {
    element: Element<'a, Action>,
    node: layout::Node,
}

struct RowState {
    id: String,
    tree: Tree,
}

type RowStates = BTreeMap<usize, RowState>;

pub(super) struct Transcript<'a> {
    items: &'a [Item],
    theme: &'a Theme,
    copied: Option<(&'a str, CopyFormat)>,
    reading: &'a ReadingPosition,
    limits: layout::Limits,
    rows: RefCell<BTreeMap<usize, Row<'a>>>,
}

impl<'a> Transcript<'a> {
    pub(super) fn new(
        items: &'a [Item],
        theme: &'a Theme,
        copied: Option<(&'a str, CopyFormat)>,
        reading: &'a ReadingPosition,
    ) -> Self {
        Self {
            items,
            theme,
            copied,
            reading,
            limits: layout::Limits::NONE,
            rows: RefCell::default(),
        }
    }

    // The layout keeps exact row positions for the scrollbar and history anchor.
    // Detailed widgets and text layout state are kept only near the viewport.
    fn visible(layout: Layout<'_>, viewport: &Rectangle) -> Range<usize> {
        let len = layout.children().len();
        let top = viewport.y - OVERSCAN;
        let bottom = viewport.y + viewport.height + OVERSCAN;
        let first = first_row(layout, top);
        let end = first
            + partition(len - first, |index| {
                layout.child(first + index).position().y <= bottom
            });
        first..end
    }

    fn mount(&self, states: &mut RowStates, renderer: &Renderer, visible: Range<usize>) {
        let mut rows = self.rows.borrow_mut();
        if states.len() == rows.len()
            && rows.len() == visible.len()
            && (visible.is_empty() || rows.contains_key(&visible.start))
        {
            return;
        }
        rows.retain(|index, _| visible.contains(index));
        states.retain(|index, _| visible.contains(index));
        for index in visible {
            rows.entry(index).or_insert_with(|| {
                let item = &self.items[index];
                let mut element = entry(item, self.theme, self.copied);
                let state = states.entry(index).or_insert_with(|| RowState {
                    id: item.id.clone(),
                    tree: Tree::empty(),
                });
                if state.id != item.id {
                    state.id.clone_from(&item.id);
                    state.tree = Tree::empty();
                }
                state.tree.diff(element.as_widget());
                let node = element
                    .as_widget_mut()
                    .layout(&mut state.tree, renderer, &self.limits);
                Row { element, node }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewport_mounts_only_nearby_rows_even_with_one_very_tall_reply() {
        let children = (0..320)
            .map(|i| {
                let height = if i == 319 { 5000.0 } else { 32.0 };
                layout::Node::new(Size::new(760.0, height))
                    .move_to(Point::new(0.0, i as f32 * 44.0))
            })
            .collect();
        let layout = layout::Node::with_children(Size::new(760.0, 19_036.0), children)
            .move_to(Point::new(100.0, 40.0));
        let view = |y| Rectangle {
            x: 100.0,
            y,
            width: 760.0,
            height: 480.0,
        };
        assert_eq!(
            Transcript::visible(Layout::new(&layout), &view(40.0)),
            0..15
        );
        assert_eq!(
            Transcript::visible(Layout::new(&layout), &view(17_100.0)),
            319..320
        );
        assert_eq!(
            Transcript::visible(Layout::new(&layout), &view(20_000.0)),
            320..320
        );
    }
}

fn first_row(layout: Layout<'_>, top: f32) -> usize {
    partition(layout.children().len(), |index| {
        let row = layout.child(index).bounds();
        row.y + row.height <= top
    })
}

fn partition(len: usize, before: impl Fn(usize) -> bool) -> usize {
    let (mut low, mut high) = (0, len);
    while low < high {
        let mid = low + (high - low) / 2;
        if before(mid) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    low
}

fn positioned<'a>(node: &'a layout::Node, proxy: Layout<'_>) -> Layout<'a> {
    let point = proxy.position();
    Layout::with_offset(Vector::new(point.x, point.y), node)
}

impl Widget<Action, Theme, Renderer> for Transcript<'_> {
    fn size(&self) -> Size<Length> {
        Size::new(Fill, Length::Shrink)
    }

    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<RowStates>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(RefCell::new(RowStates::new()))
    }

    fn layout(
        &mut self,
        _tree: &mut Tree,
        renderer: &Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        let width = limits.max().width;
        let row_limits = layout::Limits::with_compression(
            Size::ZERO,
            Size::new(width, f32::INFINITY),
            Size::new(false, true),
        );
        if self.limits != row_limits {
            self.limits = row_limits;
            self.rows.get_mut().clear();
        }

        let mut y = 0.0;
        let positions = self
            .items
            .iter()
            .map(|item| {
                let size = match item.measurement.get() {
                    Some(measured)
                        if measured.limits == row_limits
                            && measured.has_copy == item.copy_ready =>
                    {
                        measured.size
                    }
                    _ => {
                        let mut element = entry(item, self.theme, None);
                        let mut state = Tree::new(element.as_widget());
                        let size = element
                            .as_widget_mut()
                            .layout(&mut state, renderer, &row_limits)
                            .size();
                        item.measurement.set(Some(Measurement {
                            limits: row_limits,
                            has_copy: item.copy_ready,
                            size,
                        }));
                        size
                    }
                };
                let node = layout::Node::new(size).move_to(Point::new(0.0, y));
                y += size.height + SPACING;
                node
            })
            .collect();
        layout::Node::with_children(Size::new(width, (y - SPACING).max(0.0)), positions)
    }

    fn operate(
        &mut self,
        tree: &mut Tree,
        layout: Layout<'_>,
        renderer: &Renderer,
        operation: &mut dyn Operation,
    ) {
        let rows = self.rows.get_mut();
        let states = tree.state.downcast_mut::<RefCell<RowStates>>().get_mut();
        operation.container(None, layout.bounds());
        operation.traverse(&mut |operation| {
            for (index, row) in rows.iter_mut() {
                row.element.as_widget_mut().operate(
                    &mut states.get_mut(index).expect("mounted row state").tree,
                    positioned(&row.node, layout.child(*index)),
                    renderer,
                    operation,
                );
            }
        });
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Action>,
        viewport: &Rectangle,
    ) {
        let states = tree.state.downcast_mut::<RefCell<RowStates>>().get_mut();
        self.mount(states, renderer, Self::visible(layout, viewport));
        for (index, row) in self.rows.get_mut() {
            row.element.as_widget_mut().update(
                &mut states.get_mut(index).expect("mounted row state").tree,
                event,
                positioned(&row.node, layout.child(*index)),
                cursor,
                renderer,
                clipboard,
                shell,
                viewport,
            );
        }
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        #[cfg(feature = "visual-check")]
        let paint_started = std::time::Instant::now();
        self.reading
            .capture(self.items, layout, viewport, first_row(layout, viewport.y));
        let mut states = tree.state.downcast_ref::<RefCell<RowStates>>().borrow_mut();
        self.mount(&mut states, renderer, Self::visible(layout, viewport));
        for (index, row) in self.rows.borrow().iter() {
            let row_layout = positioned(&row.node, layout.child(*index));
            if row_layout.bounds().intersects(viewport) {
                row.element.as_widget().draw(
                    &states[index].tree,
                    renderer,
                    theme,
                    style,
                    row_layout,
                    cursor,
                    viewport,
                );
            }
        }
        #[cfg(feature = "visual-check")]
        self.reading.record_paint(viewport, paint_started);
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        let states = tree.state.downcast_ref::<RefCell<RowStates>>().borrow();
        self.rows
            .borrow()
            .iter()
            .map(|(index, row)| {
                row.element.as_widget().mouse_interaction(
                    &states[index].tree,
                    positioned(&row.node, layout.child(*index)),
                    cursor,
                    viewport,
                    renderer,
                )
            })
            .max()
            .unwrap_or_default()
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout<'b>,
        renderer: &Renderer,
        viewport: &Rectangle,
        translation: Vector,
    ) -> Option<overlay::Element<'b, Action, Theme, Renderer>> {
        let states = tree.state.downcast_mut::<RefCell<RowStates>>().get_mut();
        let overlays: Vec<_> = self
            .rows
            .get_mut()
            .iter_mut()
            .zip(states.values_mut())
            .filter_map(|((index, row), state)| {
                row.element.as_widget_mut().overlay(
                    &mut state.tree,
                    positioned(&row.node, layout.child(*index)),
                    renderer,
                    viewport,
                    translation,
                )
            })
            .collect();
        (!overlays.is_empty()).then(|| overlay::Group::with_children(overlays).overlay())
    }
}

fn entry<'a>(
    item: &'a Item,
    theme: &'a Theme,
    copied: Option<(&str, CopyFormat)>,
) -> Element<'a, Action> {
    let body: Element<'a, Action> = match item.kind {
        Kind::User => container(
            container(if let Some(parsed) = &item.parsed {
                theme::reading_markdown(parsed.items(), theme::BODY_SIZE, theme::INK, theme)
                    .map(Action::Link)
            } else {
                text(&item.value)
                    .size(theme::BODY_SIZE)
                    .line_height(theme::BODY_LEADING)
                    .into()
            })
            .padding([9, 14])
            .max_width(538)
            .style(|_| theme::rounded(theme::BUBBLE, 14.0)),
        )
        .width(Fill)
        .align_x(Right)
        .into(),
        Kind::Reply => {
            let response = if let Some(parsed) = &item.parsed {
                theme::reading_markdown(parsed.items(), theme::BODY_SIZE, theme::INK, theme)
                    .map(Action::Link)
            } else {
                text(&item.value)
                    .size(theme::BODY_SIZE)
                    .line_height(theme::BODY_LEADING)
                    .into()
            };
            container(response).into()
        }
        Kind::Activity(kind) => activity::view(item, kind, theme),
    };
    if !item.copy_ready {
        return body;
    }
    let selected = copied
        .filter(|(id, _)| *id == item.id)
        .map(|(_, format)| format);
    column![
        body,
        container(
            row![
                copy_icon(&item.id, CopyFormat::Markdown, selected),
                copy_icon(&item.id, CopyFormat::RichText, selected),
            ]
            .spacing(4)
        )
        .width(Fill)
        .align_x(Right),
    ]
    .spacing(4)
    .into()
}

fn copy_icon<'a>(
    id: &str,
    format: CopyFormat,
    selected: Option<CopyFormat>,
) -> Element<'a, Action> {
    static MARKDOWN: OnceLock<svg::Handle> = OnceLock::new();
    static RICH_TEXT: OnceLock<svg::Handle> = OnceLock::new();
    static CHECK: OnceLock<svg::Handle> = OnceLock::new();
    let (handle, path, label) = match (format, selected == Some(format)) {
        (_, true) => (&CHECK, "m5 12 4 4L19 6", "Copied"),
        (CopyFormat::Markdown, false) => (
            &MARKDOWN,
            "M2 5h20v14H2z M5 15V9l3 3 3-3v6 M16.5 9v6m-2-2 2 2 2-2",
            "Copy Markdown",
        ),
        (CopyFormat::RichText, false) => (
            &RICH_TEXT,
            "M7 7V3h13v14h-4 M4 7h12v14H4z M7 11h6m-6 4h6",
            "Copy formatted text",
        ),
    };
    let icon = handle.get_or_init(|| svg::Handle::from_memory(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="{path}" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>"#
    ).into_bytes())).clone();
    let icon_color = if selected == Some(format) {
        theme::GREEN
    } else {
        theme::MUTED
    };
    tooltip(
        button(
            svg(icon)
                .width(16)
                .height(16)
                .style(move |_, _| svg::Style {
                    color: Some(icon_color),
                }),
        )
        .on_press(Action::Copy(id.into(), format))
        .width(28)
        .height(28)
        .padding(6)
        .style(|_, status| theme::tab(false, status)),
        container(text(label).size(12))
            .padding([5, 8])
            .style(|_| theme::panel(theme::CHROME, 6.0)),
        tooltip::Position::Top,
    )
    .gap(5)
    .into()
}
