use super::{Action, Activity, Item, Kind, action};
use crate::theme;
use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout, mouse, overlay, renderer,
    widget::{Operation, Tree, tree},
};
use iced::widget::{Space, button, column, container, markdown, row, svg, text};
use iced::{
    Center, Element, Event, Fill, Length, Point, Rectangle, Renderer, Right, Size, Theme, Vector,
};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ops::Range;

const SPACING: f32 = 12.0;
const OVERSCAN: f32 = 160.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CopyButton {
    Hidden,
    Copy,
    Copied,
}

#[derive(Clone, Copy)]
pub(super) struct Measurement {
    limits: layout::Limits,
    copy: CopyButton,
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
    in_flight: bool,
    copied: Option<&'a str>,
    limits: layout::Limits,
    rows: RefCell<BTreeMap<usize, Row<'a>>>,
}

impl<'a> Transcript<'a> {
    pub(super) fn new(
        items: &'a [Item],
        theme: &'a Theme,
        in_flight: bool,
        copied: Option<&'a str>,
    ) -> Self {
        Self {
            items,
            theme,
            in_flight,
            copied,
            limits: layout::Limits::NONE,
            rows: RefCell::default(),
        }
    }

    fn copy_button(&self, item: &Item) -> CopyButton {
        if self.in_flight || !matches!(item.kind, Kind::Reply) || item.parsed.is_none() {
            CopyButton::Hidden
        } else if self.copied == Some(&item.id) {
            CopyButton::Copied
        } else {
            CopyButton::Copy
        }
    }

    // The layout keeps exact row positions for the scrollbar and history anchor.
    // Detailed widgets and text layout state are kept only near the viewport.
    fn visible(layout: Layout<'_>, viewport: &Rectangle) -> Range<usize> {
        let len = layout.children().len();
        let top = viewport.y - OVERSCAN;
        let bottom = viewport.y + viewport.height + OVERSCAN;
        let first = partition(len, |index| {
            let row = layout.child(index).bounds();
            row.y + row.height < top
        });
        let end = first
            + partition(len - first, |index| {
                layout.child(first + index).position().y <= bottom
            });
        first..end
    }

    fn mount(&self, states: &mut RowStates, renderer: &Renderer, visible: Range<usize>) {
        let mut rows = self.rows.borrow_mut();
        rows.retain(|index, _| visible.contains(index));
        states.retain(|index, _| visible.contains(index));
        for index in visible {
            rows.entry(index).or_insert_with(|| {
                let item = &self.items[index];
                let mut element = entry(item, self.theme, self.copy_button(item));
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
                let copy = self.copy_button(item);
                let size = match item.measurement.get() {
                    Some(measured) if measured.limits == row_limits && measured.copy == copy => {
                        measured.size
                    }
                    _ => {
                        let mut element = entry(item, self.theme, copy);
                        let mut state = Tree::new(element.as_widget());
                        let size = element
                            .as_widget_mut()
                            .layout(&mut state, renderer, &row_limits)
                            .size();
                        item.measurement.set(Some(Measurement {
                            limits: row_limits,
                            copy,
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

fn entry<'a>(item: &'a Item, theme: &'a Theme, copy: CopyButton) -> Element<'a, Action> {
    match item.kind {
        Kind::User => container(
            container(if let Some(parsed) = &item.parsed {
                markdown::view(
                    parsed.items(),
                    markdown::Settings::with_text_size(15, theme),
                )
                .map(Action::Link)
            } else {
                text(&item.value).size(15).into()
            })
            .padding([10, 14])
            .max_width(580)
            .style(|_| theme::rounded(theme::HIGHLIGHT, 14.0)),
        )
        .width(Fill)
        .align_x(Right),
        Kind::Reply => {
            let response = if let Some(parsed) = &item.parsed {
                markdown::view(
                    parsed.items(),
                    markdown::Settings::with_text_size(15, theme),
                )
                .map(Action::Link)
            } else {
                text(&item.value).size(15).into()
            };
            let mut body = column![response].spacing(4);
            if copy != CopyButton::Hidden {
                let label = if copy == CopyButton::Copied {
                    "Copied"
                } else {
                    "Copy"
                };
                body = body.push(
                    container(action(label, Some(Action::Copy(item.id.clone())), false))
                        .width(Fill)
                        .align_x(Right),
                );
            }
            container(body)
        }
        Kind::Activity(kind) => {
            let toggle = button(
                row![
                    svg(kind.icon())
                        .width(15)
                        .height(15)
                        .style(|_, _| svg::Style {
                            color: Some(theme::MUTED),
                        }),
                    text(&item.title).size(13),
                    Space::new().width(Fill),
                    text(if item.expanded { "⌃" } else { "⌄" }).size(15),
                ]
                .spacing(8)
                .align_y(Center),
            )
            .on_press(Action::Toggle(item.id.clone()))
            .width(Fill)
            .padding([4, 7])
            .style(move |_, status| theme::tab(item.expanded, status));
            let mut activity = column![toggle].spacing(5);
            if item.expanded {
                let detail: Element<'_, Action> = match kind {
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
                    _ => text(&item.value)
                        .size(13)
                        .font(iced::Font::MONOSPACE)
                        .into(),
                };
                activity = activity.push(container(detail).padding([7, 14]));
            }
            container(activity).width(Fill)
        }
    }
    .into()
}
