//! Keep a message pinned in the viewport when the transcript's geometry changes.
use super::{Action, Item};
use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout, mouse, overlay, renderer,
    widget::{Id, Operation, Tree, operation, tree},
};
use iced::{Element, Event, Length, Rectangle, Renderer, Size, Theme, Vector};
use std::cell::RefCell;

pub(super) const VERTICAL_PADDING: u16 = 20;

#[derive(Default)]
pub(super) struct ReadingPosition(RefCell<Option<Anchor>>);

struct Anchor {
    item_id: String,
    index: usize,
    // Positive inside the row, negative when the viewport starts in the gap above it.
    into_row: f32,
    from_bottom: f32,
}

impl ReadingPosition {
    pub(super) fn clear(&mut self) {
        self.0.get_mut().take();
    }

    pub(super) fn capture(
        &self,
        items: &[Item],
        layout: Layout<'_>,
        viewport: &Rectangle,
        first: usize,
    ) {
        let mut position = self.0.borrow_mut();
        let bounds = layout.bounds();
        let from_bottom = (bounds.y + bounds.height + f32::from(VERTICAL_PADDING))
            - (viewport.y + viewport.height);
        if from_bottom <= 2.0 || first >= items.len() {
            *position = None;
            return;
        }

        let id = &items[first].id;
        let into_row = viewport.y - layout.child(first).position().y;
        match position.as_mut() {
            Some(anchor) => {
                if anchor.item_id != *id {
                    anchor.item_id.clone_from(id);
                }
                anchor.into_row = into_row;
                anchor.from_bottom = from_bottom;
                anchor.index = first;
            }
            None => {
                *position = Some(Anchor {
                    item_id: id.clone(),
                    index: first,
                    into_row,
                    from_bottom,
                });
            }
        }
    }

    #[cfg(feature = "visual-check")]
    pub(super) fn probe(&self) -> Option<(String, f32)> {
        let saved = self.0.borrow();
        let anchor = saved.as_ref()?;
        Some((anchor.item_id.clone(), anchor.into_row))
    }
}

pub(super) struct TranscriptScroll<'a> {
    scroll: Element<'a, Action>,
    reading: &'a ReadingPosition,
    items: &'a [Item],
}

impl<'a> TranscriptScroll<'a> {
    pub(super) fn wrap(
        scroll: Element<'a, Action>,
        reading: &'a ReadingPosition,
        items: &'a [Item],
    ) -> Element<'a, Action> {
        Element::new(Self {
            scroll,
            reading,
            items,
        })
    }

    fn restore(&self, layout: Layout<'_>) -> Option<Restore> {
        let position = self.reading.0.borrow();
        let anchor = position.as_ref()?;
        let index = if self
            .items
            .get(anchor.index)
            .is_some_and(|item| item.id == anchor.item_id)
        {
            anchor.index
        } else {
            self.items
                .iter()
                .position(|item| item.id == anchor.item_id)?
        };

        // The scroll content has an outer padding container, a centered reading
        // column, and the transcript after the optional history-loading button.
        let content = layout.child(0);
        let transcript = content.child(0).child(0).children().last()?;
        let row = transcript.child(index).bounds();
        let into_row = anchor.into_row.min((row.height - 1.0).max(0.0));
        let span = (content.bounds().height - layout.bounds().height).max(0.0);
        let target = (span - (row.y - content.position().y + into_row)).clamp(0.0, span);
        ((target - anchor.from_bottom).abs() > 1.0).then_some(Restore {
            previous: anchor.from_bottom,
            target,
        })
    }
}

struct Restore {
    previous: f32,
    target: f32,
}

impl Operation for Restore {
    fn traverse(&mut self, _operate: &mut dyn FnMut(&mut dyn Operation)) {
        // Only the outer scrollable is targeted.
    }

    fn scrollable(
        &mut self,
        _id: Option<&Id>,
        bounds: Rectangle,
        content: Rectangle,
        translation: Vector,
        state: &mut dyn operation::Scrollable,
    ) {
        let span = (content.height - bounds.height).max(0.0);
        let current = span - translation.y;
        // A direct scroll between layout passes takes precedence over a
        // position captured on the previous frame.
        if (current - self.previous.min(span)).abs() <= 1.5 {
            state.scroll_to(operation::scrollable::AbsoluteOffset {
                x: None,
                y: Some(self.target),
            });
        }
    }
}

impl Widget<Action, Theme, Renderer> for TranscriptScroll<'_> {
    fn size(&self) -> Size<Length> {
        self.scroll.as_widget().size()
    }

    fn tag(&self) -> tree::Tag {
        self.scroll.as_widget().tag()
    }

    fn state(&self) -> tree::State {
        self.scroll.as_widget().state()
    }

    fn children(&self) -> Vec<Tree> {
        self.scroll.as_widget().children()
    }

    fn diff(&self, tree: &mut Tree) {
        self.scroll.as_widget().diff(tree);
    }

    fn layout(
        &mut self,
        tree: &mut Tree,
        renderer: &Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        let node = self.scroll.as_widget_mut().layout(tree, renderer, limits);
        let layout = Layout::new(&node);
        if let Some(mut restore) = self.restore(layout) {
            self.scroll
                .as_widget_mut()
                .operate(tree, layout, renderer, &mut restore);
        }
        node
    }

    fn operate(
        &mut self,
        tree: &mut Tree,
        layout: Layout<'_>,
        renderer: &Renderer,
        operation: &mut dyn Operation,
    ) {
        self.scroll
            .as_widget_mut()
            .operate(tree, layout, renderer, operation);
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
        self.scroll.as_widget_mut().update(
            tree, event, layout, cursor, renderer, clipboard, shell, viewport,
        );
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
        self.scroll
            .as_widget()
            .draw(tree, renderer, theme, style, layout, cursor, viewport);
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        self.scroll
            .as_widget()
            .mouse_interaction(tree, layout, cursor, viewport, renderer)
    }

    fn overlay<'a>(
        &'a mut self,
        tree: &'a mut Tree,
        layout: Layout<'a>,
        renderer: &Renderer,
        viewport: &Rectangle,
        translation: Vector,
    ) -> Option<overlay::Element<'a, Action, Theme, Renderer>> {
        self.scroll
            .as_widget_mut()
            .overlay(tree, layout, renderer, viewport, translation)
    }
}
