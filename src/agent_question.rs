use crate::agent_interaction::{Question, answers, display};
use crate::agent_render;
use gtk::prelude::*;
use serde_json::Value;

pub fn card(params: &Value, submit: impl Fn(Value) + 'static) -> Option<gtk::Box> {
    let questions = Question::read(params)?;
    let card = gtk::Box::new(gtk::Orientation::Vertical, 8);
    card.style_context().add_class("agent-question");
    let mut fields = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        let group = gtk::Box::new(gtk::Orientation::Vertical, 5);
        let header = if questions.len() > 1 {
            format!("{} / {}   {}", index + 1, questions.len(), question.header)
        } else {
            question.header.clone()
        };
        if !header.is_empty() {
            let header = agent_render::text(&header);
            header.style_context().add_class("agent-status");
            group.add(&header);
        }
        group.add(&agent_render::text(&question.prompt));
        fields.push(Field::new(&group, question));
        card.add(&group);
    }

    let footer = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let status = agent_render::text("");
    status.style_context().add_class("agent-status");
    let answer = gtk::Button::with_label("提交答案");
    answer.style_context().add_class("primary");
    footer.pack_start(&status, true, true, 0);
    footer.pack_end(&answer, false, false, 0);
    card.add(&footer);

    answer.connect_clicked(move |_| {
        let inputs: Vec<_> = fields.iter().map(|field| field.input.text()).collect();
        let fields =
            questions
                .iter()
                .zip(fields.iter().zip(&inputs))
                .map(|(question, (field, input))| {
                    (
                        question,
                        field.options.iter().position(|option| option.is_active()),
                        input.as_str(),
                    )
                });
        if let Some(result) = answers(fields) {
            submit(result);
        } else {
            status.set_text("请回答所有问题");
        }
    });
    Some(card)
}

struct Field {
    options: Vec<gtk::RadioButton>,
    input: gtk::Entry,
}

impl Field {
    fn new(group: &gtk::Box, question: &Question) -> Self {
        let input = gtk::Entry::new();
        input.set_placeholder_text(Some(if question.secret {
            "输入答案（内容隐藏）"
        } else {
            "输入答案"
        }));
        input.set_visibility(!question.secret);
        if let Some(accessible) = input.accessible() {
            accessible.set_name("输入答案");
        }

        let unselected = gtk::RadioButton::builder().active(true).build();
        let mut options = Vec::new();
        let all_choices = question
            .options
            .iter()
            .map(|choice| (display(&choice.label), choice.description.as_str()))
            .chain(
                (question.allow_other && !question.options.is_empty())
                    .then(|| ("其他答案".into(), "")),
            );
        for (label, description) in all_choices {
            let choice = gtk::RadioButton::with_label_from_widget(&unselected, &label);
            choice.style_context().add_class("agent-question-option");
            group.add(&choice);
            if !description.is_empty() {
                let detail = agent_render::text(description);
                detail.style_context().add_class("agent-question-detail");
                group.add(&detail);
            }
            options.push(choice);
        }
        // Keep the unselected radio in the group but outside the keyboard tab order.
        if !options.is_empty() {
            unselected.set_no_show_all(true);
            group.add(&unselected);
        }
        if options.is_empty() || question.allow_other {
            group.add(&input);
            if let Some(other) = options.last() {
                input.set_no_show_all(true);
                let input = input.downgrade();
                other.connect_toggled(move |other| {
                    if let Some(input) = input.upgrade() {
                        input.set_visible(other.is_active());
                        if other.is_active() {
                            input.grab_focus();
                        }
                    }
                });
            }
        }
        Self { options, input }
    }
}
