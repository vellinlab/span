use super::{Action, Agent, Request, action};
use crate::theme;
use iced::widget::{button, column, container, float, row, text, text_editor, tooltip};
use iced::{Bottom, Center, Element, Fill, Task, Vector};
use serde_json::{Value, json};

const PREFIX: &str = "/goal";
const MAX_OBJECTIVE: usize = 4_000;
const MAX_COMMAND_LENGTH: usize = "/goal resume".len();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Set,
    Status,
    Edit,
    Pause,
    Resume,
    Clear,
}

impl Command {
    const ALL: [Self; 6] = [
        Self::Set,
        Self::Status,
        Self::Edit,
        Self::Pause,
        Self::Resume,
        Self::Clear,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Set => "/goal",
            Self::Status => "/goal status",
            Self::Edit => "/goal edit",
            Self::Pause => "/goal pause",
            Self::Resume => "/goal resume",
            Self::Clear => "/goal clear",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Set => "Set goal",
            Self::Status => "View goal",
            Self::Edit => "Edit goal",
            Self::Pause => "Pause goal",
            Self::Resume => "Resume goal",
            Self::Clear => "Clear goal",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Operation {
    Refresh,
    Status,
    Save,
    Change,
    Clear,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Pending {
    pub operation: Operation,
    revision: u64,
}

struct Goal {
    objective: String,
    preview: String,
    status: String,
    elapsed: Option<String>,
}

pub(super) struct Draft {
    pub content: text_editor::Content,
    activate: bool,
}

#[derive(Default)]
pub(super) struct State {
    current: Option<Goal>,
    pub draft: Option<Draft>,
    pub suggestions: Vec<Command>,
    pub selected: usize,
    revision: u64,
}

impl State {
    pub fn update(&mut self, value: &Value) {
        self.revision = self.revision.wrapping_add(1);
        self.read(value);
    }

    fn read(&mut self, value: &Value) {
        self.current = value["objective"].as_str().map(|objective| {
            let objective: String = objective.chars().take(MAX_OBJECTIVE).collect();
            let mut preview = objective.split_whitespace().collect::<Vec<_>>().join(" ");
            let end = preview.char_indices().nth(100).map(|(index, _)| index);
            if let Some(end) = end {
                preview.truncate(end);
                preview.push('…');
            }
            Goal {
                objective,
                preview,
                status: value["status"].as_str().unwrap_or_default().into(),
                elapsed: value["timeUsedSeconds"]
                    .as_u64()
                    .map(crate::agent_interaction::elapsed),
            }
        });
    }

    pub fn refresh_suggestions(&mut self, content: &text_editor::Content) {
        self.suggestions.clear();
        self.selected = 0;
        if content.line_count() != 1 || content.cursor().position.column > MAX_COMMAND_LENGTH {
            return;
        }
        if let Some(line) = content.line(0) {
            let prefix = line.text.as_ref();
            if prefix.starts_with('/') {
                for command in Command::ALL {
                    if command.name().starts_with(prefix) && self.offers(command) {
                        self.suggestions.push(command);
                    }
                }
            }
        }
    }

    fn offers(&self, command: Command) -> bool {
        let status = self.current.as_ref().map(|goal| goal.status.as_str());
        match command {
            Command::Set | Command::Status => true,
            Command::Pause => status == Some("active"),
            Command::Resume => matches!(status, Some("paused" | "blocked")),
            Command::Edit | Command::Clear => status.is_some(),
        }
    }

    pub fn advance(&mut self, delta: i8) {
        if !self.suggestions.is_empty() {
            self.selected =
                (self.selected as i8 + delta).rem_euclid(self.suggestions.len() as i8) as usize;
        }
    }

    pub fn palette(&self) -> Element<'_, Action> {
        let options =
            self.suggestions
                .iter()
                .enumerate()
                .fold(column![].spacing(2), |rows, (i, command)| {
                    rows.push(
                        button(
                            row![
                                text(command.label()).size(14).width(Fill),
                                text(command.name()).size(12).color(theme::MUTED),
                            ]
                            .spacing(10)
                            .align_y(Center),
                        )
                        .width(Fill)
                        .padding([7, 10])
                        .style(move |_, status| theme::tab(i == self.selected, status))
                        .on_press(Action::GoalSelect(*command)),
                    )
                });
        let popup = container(options)
            .padding(5)
            .width(302)
            .style(|_| theme::panel(theme::CHROME, 10.0));
        container(
            container(float(popup).translate(|_, _| Vector::new(0.0, -4.0)))
                .width(Fill)
                .max_width(760)
                .height(Fill)
                .align_y(Bottom),
        )
        .padding([0, 24])
        .center_x(Fill)
        .height(Fill)
        .into()
    }

    pub fn summary(&self) -> Option<Element<'_, Action>> {
        let goal = self.current.as_ref()?;
        let (status, color) = match goal.status.as_str() {
            "active" => ("Active", theme::BLUE),
            "paused" => ("Paused", theme::MUTED),
            "blocked" => ("Blocked", theme::ERROR),
            "complete" => ("Complete", theme::GREEN),
            "budgetLimited" | "usageLimited" => ("Limit reached", theme::MUTED),
            _ => ("Goal", theme::MUTED),
        };
        Some(
            tooltip(
                container(
                    row![
                        text("◎").size(16).color(color),
                        text(status).size(13).font(theme::SEMIBOLD),
                        text(&goal.preview)
                            .size(13)
                            .wrapping(text::Wrapping::WordOrGlyph)
                            .width(Fill),
                        text(goal.elapsed.as_deref().unwrap_or_default())
                            .size(12)
                            .color(theme::MUTED),
                    ]
                    .spacing(8)
                    .align_y(Center),
                )
                .padding([7, 9])
                .style(|_| theme::panel(theme::WORK, 7.0)),
                container(
                    text(&goal.objective)
                        .size(13)
                        .wrapping(text::Wrapping::WordOrGlyph),
                )
                .max_width(420)
                .max_height(240)
                .padding(10)
                .style(|_| theme::panel(theme::CHROME, 8.0)),
                tooltip::Position::Top,
            )
            .into(),
        )
    }
}

impl Agent {
    pub(super) fn goal_menu_open(&self) -> bool {
        self.goals.draft.is_none() && self.can_use_goal() && !self.goals.suggestions.is_empty()
    }

    pub(super) fn goal_pending(&self) -> bool {
        self.pending.values().any(|request| {
            matches!(request, Request::Goal(pending) if pending.operation != Operation::Refresh)
        })
    }

    pub(super) fn can_use_goal(&self) -> bool {
        self.connection.is_some()
            && self.thread.is_some()
            && self.preparing.is_none()
            && self.submitted_draft.is_none()
            && !self.goal_pending()
            && !self
                .pending
                .values()
                .any(|request| *request == Request::Open)
    }

    fn request_goal(&mut self, operation: Operation, method: &str, params: Value) -> bool {
        self.request(
            Request::Goal(Pending {
                operation,
                revision: self.goals.revision,
            }),
            method,
            params,
        )
    }

    pub(super) fn refresh_goal(&mut self, thread: &str) {
        self.request_goal(
            Operation::Refresh,
            "thread/goal/get",
            json!({"threadId":thread}),
        );
    }

    pub(super) fn goal_response(&mut self, pending: Pending, result: &Value) {
        if pending.revision == self.goals.revision {
            if matches!(pending.operation, Operation::Refresh | Operation::Status) {
                self.goals.read(&result["goal"]);
            } else {
                self.goals.update(&result["goal"]);
            }
        }
        match pending.operation {
            Operation::Status if self.goals.current.is_none() => {
                self.status = Some("This session has no goal.".into());
            }
            Operation::Save => {
                self.goals.draft = None;
                self.status = None;
            }
            _ => {}
        }
    }

    fn consume_goal_command(&mut self) {
        let is_command = self.draft.line(0).is_some_and(|line| {
            arguments(&line.text).is_some()
                || Command::ALL
                    .into_iter()
                    .any(|command| command.name().starts_with(line.text.as_ref()))
        });
        if is_command {
            self.draft = text_editor::Content::new();
        }
        self.goals.suggestions.clear();
        self.status = None;
    }

    pub(super) fn select_goal(&mut self, command: Command) -> Task<Action> {
        if !self.can_use_goal() || self.goals.draft.is_some() {
            return Task::none();
        }
        let Some(thread) = self.thread.as_deref() else {
            return Task::none();
        };
        let requested = match command {
            Command::Set | Command::Edit => {
                let objective = if command == Command::Edit {
                    self.goals
                        .current
                        .as_ref()
                        .map(|goal| goal.objective.as_str())
                        .unwrap_or_default()
                } else {
                    ""
                };
                return self.begin_goal_draft(
                    objective.to_owned(),
                    command == Command::Set || objective.is_empty(),
                );
            }
            Command::Status => self.request_goal(
                Operation::Status,
                "thread/goal/get",
                json!({"threadId":thread}),
            ),
            Command::Pause | Command::Resume => self.request_goal(
                Operation::Change,
                "thread/goal/set",
                json!({"threadId":thread,"origin":"user",
                    "status":if command == Command::Pause {"paused"} else {"active"}}),
            ),
            Command::Clear => self.request_goal(
                Operation::Clear,
                "thread/goal/clear",
                json!({"threadId":thread,"origin":"user"}),
            ),
        };
        if requested {
            self.consume_goal_command();
        }
        iced::widget::operation::focus(self.composer_id.clone())
    }

    fn begin_goal_draft(&mut self, objective: String, activate: bool) -> Task<Action> {
        self.consume_goal_command();
        let mut content = text_editor::Content::with_text(&objective);
        content.perform(text_editor::Action::Move(text_editor::Motion::DocumentEnd));
        self.goals.draft = Some(Draft { content, activate });
        iced::widget::operation::focus(self.composer_id.clone())
    }

    pub(super) fn dismiss_goal(&mut self) -> Task<Action> {
        self.goals.suggestions.clear();
        if self.goals.draft.is_some() && !self.goal_pending() {
            self.goals.draft = None;
            self.preparing = None;
            self.status = None;
            return iced::widget::operation::focus(self.composer_id.clone());
        }
        Task::none()
    }

    pub(super) fn send_composer(&mut self) -> Task<Action> {
        if let Some(draft) = &self.goals.draft {
            if !self.can_use_goal() {
                return Task::none();
            }
            let objective = draft.content.text();
            let objective = objective.trim();
            if objective.is_empty() || objective.chars().count() > MAX_OBJECTIVE {
                self.status = Some("Enter a goal of up to 4,000 characters.".into());
                return Task::none();
            }
            let mut params = json!({"threadId":self.thread,"origin":"user","objective":objective});
            if draft.activate {
                params["status"] = json!("active");
            }
            if self.request_goal(Operation::Save, "thread/goal/set", params) {
                self.status = None;
            }
            return Task::none();
        }
        if let Some(command) = self.goals.suggestions.get(self.goals.selected).copied() {
            return self.select_goal(command);
        }
        let draft = self.draft.text();
        if let Some(objective) = arguments(&draft) {
            if !self.can_use_goal() {
                if self.thread.is_none() {
                    self.status = Some("Open a Codex session to set a goal.".into());
                }
                return Task::none();
            }
            if let Some(command) = Command::ALL
                .into_iter()
                .find(|command| command.name() == draft.trim())
            {
                return self.select_goal(command);
            }
            return self.begin_goal_draft(objective.trim().to_owned(), true);
        }
        self.send_draft(draft);
        Task::none()
    }

    pub(super) fn goal_draft_header(&self) -> Element<'_, Action> {
        row![
            text("Session goal")
                .size(13)
                .font(theme::SEMIBOLD)
                .color(theme::BLUE)
                .width(Fill),
            action(
                "Cancel",
                (!self.goal_pending()).then_some(Action::GoalDismiss),
                false
            )
        ]
        .align_y(Center)
        .into()
    }
}

#[cfg(feature = "visual-check")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum VisualGoal {
    Menu,
    EmptyDraft,
    FilledDraft,
    Saved,
}

#[cfg(feature = "visual-check")]
impl Agent {
    pub(crate) fn visual_goal(&self) -> Option<VisualGoal> {
        if self.goal_menu_open() {
            Some(VisualGoal::Menu)
        } else if let Some(draft) = &self.goals.draft {
            if draft.content.is_empty() {
                Some(VisualGoal::EmptyDraft)
            } else {
                Some(VisualGoal::FilledDraft)
            }
        } else if self.goals.current.is_some() {
            Some(VisualGoal::Saved)
        } else {
            None
        }
    }
}

fn arguments(input: &str) -> Option<&str> {
    let tail = input.trim_end().strip_prefix(PREFIX)?;
    (tail.is_empty() || tail.starts_with(char::is_whitespace)).then_some(tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::channel::mpsc;
    use std::sync::Arc;

    #[test]
    fn goal_palette_saves_to_the_thread_and_preserves_a_rejected_draft() {
        let (mut agent, _) = Agent::new(None, None, Default::default());
        let (sender, mut requests) = mpsc::channel(8);
        agent.connection = Some(sender);
        agent.pending.clear();
        agent.thread = Some("fixture".into());
        agent.refresh_goal("fixture");
        let refresh = requests.try_recv().expect("load the thread goal");
        assert_eq!(refresh["method"], "thread/goal/get");

        let paste = |value: &str| {
            Action::Draft(text_editor::Action::Edit(text_editor::Edit::Paste(
                Arc::new(value.into()),
            )))
        };
        let _ = agent.update(paste("/goal"));
        assert_eq!(agent.goals.suggestions, [Command::Set, Command::Status]);
        let _ = agent.update(Action::GoalSelect(Command::Set));
        assert!(agent.draft.is_empty());
        assert!(agent.goals.draft.as_ref().unwrap().content.is_empty());
        assert!(
            requests.try_recv().is_err(),
            "opening the editor sent an RPC"
        );

        let _ = agent.update(paste("Improve Windows responsiveness\nMeasure the result"));
        let _ = agent.update(Action::Send);
        let request = requests.try_recv().expect("save the goal");
        let objective = "Improve Windows responsiveness\nMeasure the result";
        assert_eq!(request["method"], "thread/goal/set");
        assert_eq!(
            request["params"],
            json!({
                "threadId":"fixture","origin":"user","objective":objective,"status":"active"
            })
        );
        let _ = agent.update(paste("a late edit while saving"));
        agent.packet(json!({"id":request["id"],"error":{"message":"Retry"}}));
        assert_eq!(
            agent.goals.draft.as_ref().unwrap().content.text(),
            objective
        );

        let _ = agent.update(Action::Send);
        let request = requests.try_recv().unwrap();
        agent.packet(
            json!({"id":request["id"],"result":{"goal":{"objective":objective,"status":"active"}}}),
        );
        agent.packet(json!({"id":refresh["id"],"result":{"goal":null}}));
        assert!(agent.goals.draft.is_none());
        assert_eq!(agent.goals.current.as_ref().unwrap().status, "active");
        assert_eq!(agent.goals.current.as_ref().unwrap().objective, objective);
        assert!(!agent.in_flight);

        agent.notification(
            "thread/goal/updated",
            &json!({"threadId":"other","goal":null}),
        );
        assert!(agent.goals.current.is_some());
        agent.notification(
            "thread/goal/updated",
            &json!({"threadId":"fixture","goal":{
                "objective":objective,"status":"paused"
            }}),
        );
        let _ = agent.update(paste("/goal edit"));
        let _ = agent.update(Action::Send);
        let _ = agent.update(Action::Send);
        let edit = requests.try_recv().expect("save edited goal");
        assert_eq!(edit["params"]["objective"], objective);
        assert!(
            edit["params"].get("status").is_none(),
            "editing must preserve Paused"
        );
    }
}
