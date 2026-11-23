use super::{Action, action};
use crate::agent_interaction::{Question, answers};
use crate::theme;
use iced::widget::{Space, column, container, radio, row, scrollable, text, text_input};
use iced::{Center, Element, Fill};
use serde_json::Value;

pub(super) struct Form {
    pub id: Value,
    fields: Vec<Field>,
}

struct Field {
    question: Question,
    selected: Option<usize>,
    input: String,
}

impl Form {
    pub fn new(id: Value, params: &Value) -> Option<Self> {
        Some(Self {
            id,
            fields: Question::read(params)?
                .into_iter()
                .map(|question| Field {
                    question,
                    selected: None,
                    input: String::new(),
                })
                .collect(),
        })
    }

    pub fn select(&mut self, index: usize, choice: usize) {
        if let Some(field) = self.fields.get_mut(index) {
            field.selected = Some(choice);
        }
    }

    pub fn edit(&mut self, index: usize, input: String) {
        if let Some(field) = self.fields.get_mut(index) {
            field.input = input;
        }
    }

    pub fn response(&self) -> Option<Value> {
        answers(
            self.fields
                .iter()
                .map(|field| (&field.question, field.selected, field.input.as_str())),
        )
    }

    pub fn view(&self) -> Element<'_, Action> {
        let mut fields = column![].spacing(10);
        for (index, field) in self.fields.iter().enumerate() {
            let question = &field.question;
            let mut group = column![].spacing(6);
            if !question.header.is_empty() {
                group = group.push(text(&question.header).size(12).color(theme::MUTED));
            }
            group = group.push(text(&question.prompt).size(14).font(theme::SEMIBOLD));
            let choices = question
                .options
                .iter()
                .map(|choice| (choice.label.as_str(), choice.description.as_str()))
                .chain(
                    (question.allow_other && !question.options.is_empty()).then_some(("Other", "")),
                );
            for (choice, (label, detail)) in choices.enumerate() {
                let id = self.id.clone();
                group = group.push(
                    radio(label, choice, field.selected, move |choice| {
                        Action::QuestionChoice(id, index, choice)
                    })
                    .size(15)
                    .text_size(14),
                );
                if !detail.is_empty() {
                    group = group.push(
                        container(text(detail).size(12).color(theme::MUTED)).padding([0, 23]),
                    );
                }
            }
            if question.options.is_empty()
                || (question.allow_other && field.selected == Some(question.options.len()))
            {
                let id = self.id.clone();
                group = group.push(
                    text_input("Your answer", &field.input)
                        .secure(question.secret)
                        .on_input(move |input| Action::QuestionText(id.clone(), index, input))
                        .size(14),
                );
            }
            fields = fields.push(group);
        }
        let ready = self.fields.iter().all(|field| {
            field
                .question
                .answer(field.selected, &field.input)
                .is_some()
        });
        container(
            column![
                container(scrollable(fields)).max_height(200),
                row![
                    Space::new().width(Fill),
                    action(
                        "Submit answers",
                        ready.then(|| Action::QuestionSubmit(self.id.clone())),
                        true
                    )
                ]
                .align_y(Center)
            ]
            .spacing(8),
        )
        .width(Fill)
        .padding(10)
        .style(|_| theme::composer())
        .into()
    }
}
