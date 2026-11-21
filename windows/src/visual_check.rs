use crate::{
    Message, SidebarPage, Tab, WorkspaceCommand, WorkspaceMenu, agent,
    agent::{CopyFormat, VisualGoal},
    codex_rpc, file_panel, host_panel,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures::channel::mpsc;
use futures::{SinkExt, StreamExt};
use iced::widget::operation::{AbsoluteOffset, scroll_to};
use iced::widget::text_editor;
use iced::{Size, Task, window};
use serde_json::{Value, json};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

mod scroll;
pub use scroll::frames;
const DIRECTORY: &str = "SPAN_VISUAL_CHECK_DIR";
const THREAD: &str = "visual-check";
const OBJECTIVE: &str = "Reduce response latency for long Windows sessions.";
const INITIAL_ITEMS: usize = 320;
const EARLIER_ITEMS: usize = 32;
const COPY_INTRO: &str = "Progress: the preview has finished.";
const COPY_MARKDOWN: &str = "### Build report\n\n| 检查 | 状态 |\n| --- | --- |\n| 终端 | **通过** |\n\n[Details](https://example.invalid/build-report)\n\n```powershell\nspan check --preview\n```";
const ACTIVITY_DIFF: &str = "diff --git a/src/preview.rs b/src/preview.rs\n--- a/src/preview.rs\n+++ b/src/preview.rs\n@@ -14,3 +14,4 @@ fn render() {\n-    let frame = redraw();\n+    let frame = cache.get_or_draw();\n+    frame.keep_position();\n     show(frame);\n }\n";

#[derive(Clone, Debug)]
pub enum Event {
    Observe,
    Latest(window::Screenshot),
    Earlier(window::Screenshot),
    Target(scroll::Target, f32),
    Frame { started: Instant, notified: Instant },
    ScrollResults(Value),
    Attachment(window::Screenshot),
    Goal(window::Screenshot),
    Resized(window::Screenshot),
    Activity(window::Screenshot),
    FileSuggestions(window::Screenshot),
    QuickConnect(window::Screenshot),
    WorkspaceNavigation(window::Screenshot),
    Menu(window::Screenshot),
    HostEditor(window::Screenshot),
    Hosts(window::Screenshot),
}

#[derive(Clone, Copy)]
enum Step {
    Open,
    CaptureLatest,
    WaitForRichCopy { scale: f32 },
    WaitForMarkdownCopy,
    WaitForHistory { end: f32 },
    CaptureEarlier { end: f32, actual: f32 },
    WaitForAttachment,
    CaptureAttachment,
    WaitForAttachmentReply,
    WaitForHistoryStream,
    WaitForGoalMenu,
    CaptureGoalMenu,
    WaitForGoalDraft,
    WaitForGoalText,
    CaptureGoalDraft,
    WaitForGoalSave,
    CaptureSavedGoal,
    WaitForResize(u32),
    FollowLatest,
    WaitForStream,
    CaptureActivityIdle,
    CaptureActivityHover,
    CaptureActivityExpanded,
    OpenFileSidebar,
    WaitForPartialPath,
    WaitForExactPath,
    CaptureFileSuggestions,
    WaitForFolder { scale: f32 },
    WaitForConnect,
    CaptureConnect,
    WaitForDrawer,
    CaptureNavigation,
    WaitForMenu,
    CaptureMenu,
    WaitForMenuAction,
    WaitForHostSidebar,
    WaitForHostEditor,
    CaptureHostEditor,
    WaitForSavedHost,
    CaptureHosts,
}

pub struct Check {
    directory: PathBuf,
    step: Step,
    first_frame: u64,
    items: usize,
    benchmark: Option<scroll::Benchmark>,
    reading: Option<(String, f32)>,
    narrow_content_height: Option<f32>,
    scale: Option<f32>,
}

pub fn enabled() -> bool {
    std::env::var_os(DIRECTORY).is_some()
}

pub fn observe() -> Task<Message> {
    Task::perform(
        async { tokio::time::sleep(Duration::from_millis(85)).await },
        |()| Message::Visual(Event::Observe),
    )
}

impl Check {
    pub fn from_env() -> Option<Self> {
        Some(Self {
            directory: std::env::var_os(DIRECTORY)?.into(),
            step: Step::Open,
            first_frame: 0,
            items: 0,
            benchmark: None,
            reading: None,
            narrow_content_height: None,
            scale: None,
        })
    }

    pub fn measuring(&self) -> bool {
        self.benchmark.is_some()
    }

    pub fn update(
        &mut self,
        event: Event,
        tab: Option<&Tab>,
        sidebar: Option<SidebarPage>,
        connecting: bool,
        menu: Option<WorkspaceMenu>,
        host_editor: bool,
    ) -> Task<Message> {
        let Some(tab) = tab else {
            return observe();
        };
        let Some(agent) = tab.agent.as_ref() else {
            return observe();
        };
        let probe = agent.visual_probe();
        match event {
            Event::Target(target, offset) => {
                let benchmark = scroll::Benchmark::new(target, offset);
                let first = benchmark.next_input();
                self.benchmark = Some(benchmark);
                return first;
            }
            Event::Frame { started, notified } => {
                if let (Some(benchmark), Some((_, view, _, _))) = (&mut self.benchmark, probe) {
                    return benchmark.frame(started, notified, view);
                }
                return Task::none();
            }
            Event::ScrollResults(results) => {
                scroll::save(&self.directory, &results);
                self.benchmark = None;
                self.reading = Some(agent.visual_reading_position().expect("reading history"));
                put_bitmap_on_clipboard();
                self.step = Step::WaitForAttachment;
                return Task::done(Message::Agent(tab.id, agent::Action::Paste)).chain(observe());
            }
            _ => {}
        }
        match (event, self.step) {
            (Event::Observe, Step::Open) => match probe {
                Some((_, view, INITIAL_ITEMS, true)) => {
                    assert!(view.from_bottom < 1.0);
                    assert!(view.from_top > 1_000.0);
                    self.step = Step::CaptureLatest;
                    let usage = json!({
                        "method": "thread/tokenUsage/updated",
                        "params": { "threadId": THREAD, "tokenUsage": {
                            "last": { "totalTokens": 224_000 }, "modelContextWindow": 800_000
                        }}
                    });
                    Task::done(Message::Agent(
                        tab.id,
                        agent::Action::Event(codex_rpc::Event::Packet(usage)),
                    ))
                    .chain(screenshot(Event::Latest))
                }
                _ => Task::batch([
                    Task::done(Message::Agent(tab.id, agent::Action::Resume(THREAD.into()))),
                    observe(),
                ]),
            },
            (Event::Latest(frame), Step::CaptureLatest) => {
                let scale = frame.scale_factor;
                std::fs::write(
                    self.directory.join("typography.json"),
                    verify_typography().to_string(),
                )
                .expect("record resolved Windows typefaces");
                self.first_frame = self.save("latest.png", frame);
                let (_, view, _, _) = probe.expect("latest viewport");
                self.step = Step::WaitForRichCopy { scale };
                click_copy(view.bounds, scale, CopyFormat::RichText)
            }
            (Event::Observe, Step::WaitForRichCopy { scale }) => {
                if !agent.visual_copied(CopyFormat::RichText) {
                    return observe();
                }
                verify_copy(CopyFormat::RichText);
                let (_, view, _, _) = probe.expect("copy viewport");
                self.step = Step::WaitForMarkdownCopy;
                click_copy(view.bounds, scale, CopyFormat::Markdown)
            }
            (Event::Observe, Step::WaitForMarkdownCopy) => {
                if !agent.visual_copied(CopyFormat::Markdown) {
                    return observe();
                }
                verify_copy(CopyFormat::Markdown);
                std::fs::write(
                    self.directory.join("copy.json"),
                    br#"{"clickedBothIcons":true,"entireTurn":true,"unicodeMarkdown":true,"formattedTable":true,"formattedLink":true,"formattedCode":true}"#,
                )
                .expect("record Windows clipboard export test");
                let (id, view, _, _) = probe.expect("latest viewport");
                let end = view.from_top - 45.0;
                self.step = Step::WaitForHistory { end };
                scroll_to(
                    id,
                    AbsoluteOffset {
                        x: None,
                        y: Some(end),
                    },
                )
                .chain(observe())
            }
            (Event::Observe, Step::WaitForHistory { end }) => match probe {
                Some((_, view, items, false)) if items == INITIAL_ITEMS + EARLIER_ITEMS => {
                    let actual = view.from_bottom;
                    if view.from_top < 200.0 {
                        return observe();
                    }
                    assert!((actual - end).abs() <= 1.0, "history moved the reader");
                    self.items = items;
                    self.step = Step::CaptureEarlier { end, actual };
                    screenshot(Event::Earlier)
                }
                _ => observe(),
            },
            (Event::Earlier(frame), Step::CaptureEarlier { end, actual }) => {
                let scale = frame.scale_factor;
                assert_ne!(self.first_frame, self.save("earlier.png", frame));
                let metrics = json!({
                    "initial_items": INITIAL_ITEMS,
                    "loaded_items": self.items,
                    "offset_before": end,
                    "offset_after": actual,
                });
                std::fs::write(
                    self.directory.join("history.json"),
                    serde_json::to_vec_pretty(&metrics).expect("encode history metrics"),
                )
                .expect("write history metrics");
                let (_, view, _, _) = probe.expect("earlier viewport");
                let bounds = view.bounds;
                let x = ((bounds.x + bounds.width * 0.46) * scale).round() as i32;
                let y = ((bounds.y + bounds.height * 0.52) * scale).round() as i32;
                window::latest().then(move |id| {
                    window::run(id.expect("active Span window"), move |window| {
                        scroll::Target::locate(window, x, y)
                    })
                    .map(move |target| Message::Visual(Event::Target(target, actual)))
                })
            }
            (Event::Observe, Step::WaitForAttachment) => {
                if agent.visual_attachment_count() != 1 {
                    return observe();
                }
                self.step = Step::CaptureAttachment;
                screenshot(Event::Attachment)
            }
            (Event::Attachment(frame), Step::CaptureAttachment) => {
                self.save("attachment.png", frame);
                self.step = Step::WaitForAttachmentReply;
                Task::done(Message::Agent(tab.id, agent::Action::Send)).chain(observe())
            }
            (Event::Observe, Step::WaitForAttachmentReply) => {
                if agent.visual_attachment_count() == 0
                    && probe.is_some_and(|(_, _, items, _)| items == self.items + 1)
                {
                    self.assert_reader(agent);
                    std::fs::write(
                        self.directory.join("attachment.json"),
                        br#"{"clipboard":"CF_DIB","input":"inline PNG","accepted":true}"#,
                    )
                    .expect("record Windows clipboard attachment test");
                    self.step = Step::WaitForHistoryStream;
                    stream(tab, "incoming-while-reading")
                } else {
                    observe()
                }
            }
            (Event::Observe, Step::WaitForHistoryStream) => {
                if !probe.is_some_and(|(_, _, items, _)| items == self.items + 2) {
                    return observe();
                }
                self.assert_reader(agent);
                self.step = Step::WaitForGoalMenu;
                paste(tab, "/goal").chain(observe())
            }
            (Event::Observe, Step::WaitForGoalMenu)
                if agent.visual_goal() == Some(VisualGoal::Menu) =>
            {
                self.step = Step::CaptureGoalMenu;
                screenshot(Event::Goal)
            }
            (Event::Goal(frame), Step::CaptureGoalMenu) => {
                let (_, view, _, _) = probe.expect("goal menu viewport");
                let bounds = view.bounds;
                let width = (bounds.width - 48.0).min(760.0);
                let x =
                    ((bounds.x + (bounds.width - width) / 2.0 + 108.0) * frame.scale_factor) as u32;
                let bottom = ((bounds.y + bounds.height) * frame.scale_factor) as u32;
                let above = (112.0 * frame.scale_factor) as u32;
                let selection = crate::theme::SELECTED.into_rgba8();
                let y = (bottom.saturating_sub(above)..bottom.min(frame.size.height))
                    .find(|y| {
                        let offset = ((y * frame.size.width + x) * 4) as usize;
                        frame.rgba.get(offset..offset + 3) == Some(&selection[..3])
                    })
                    .expect("painted Set goal menu row");
                let y = y + (8.0 * frame.scale_factor) as u32;
                self.save("goal-menu.png", frame);
                self.step = Step::WaitForGoalDraft;
                window::latest()
                    .then(move |id| {
                        window::run(id.expect("active Span window"), move |window| {
                            scroll::Target::click(window, x as i32, y as i32);
                        })
                        .discard()
                    })
                    .chain(observe())
            }
            (Event::Observe, Step::WaitForGoalDraft)
                if agent.visual_goal() == Some(VisualGoal::EmptyDraft) =>
            {
                self.step = Step::WaitForGoalText;
                paste(tab, OBJECTIVE).chain(observe())
            }
            (Event::Observe, Step::WaitForGoalText)
                if agent.visual_goal() == Some(VisualGoal::FilledDraft) =>
            {
                self.step = Step::CaptureGoalDraft;
                screenshot(Event::Goal)
            }
            (Event::Goal(frame), Step::CaptureGoalDraft) => {
                self.save("goal-edit.png", frame);
                self.step = Step::WaitForGoalSave;
                Task::done(Message::Agent(tab.id, agent::Action::Send)).chain(observe())
            }
            (Event::Observe, Step::WaitForGoalSave)
                if agent.visual_goal() == Some(VisualGoal::Saved) =>
            {
                self.step = Step::CaptureSavedGoal;
                screenshot(Event::Goal)
            }
            (Event::Goal(frame), Step::CaptureSavedGoal) => {
                self.save("goal-active.png", frame);
                std::fs::write(
                    self.directory.join("goal.json"),
                    br#"{"selectedWithMouse":true,"method":"thread/goal/set","saved":true}"#,
                )
                .expect("record native goal workflow");
                self.step = Step::WaitForResize(900);
                resize(900)
            }
            (Event::Observe, Step::WaitForResize(_)) => screenshot(Event::Resized),
            (Event::Resized(frame), Step::WaitForResize(width)) => {
                let logical_width = frame.size.width as f32 / frame.scale_factor;
                if (logical_width - width as f32).abs() > 1.0 {
                    return observe();
                }
                self.assert_reader(agent);
                self.save(&format!("resize-{width}.png"), frame);
                let (id, view, _, _) = probe.expect("resized viewport");
                let content_height = view.content.height;
                if width == 900 {
                    self.narrow_content_height = Some(content_height);
                    self.step = Step::WaitForResize(1320);
                    return resize(1320);
                }
                assert!(
                    self.narrow_content_height
                        .expect("narrow transcript height")
                        > content_height + 30.0,
                    "the narrow fixture must wrap more lines"
                );

                self.step = Step::FollowLatest;
                scroll_to(
                    id,
                    AbsoluteOffset {
                        x: None,
                        y: Some(0.0),
                    },
                )
                .chain(observe())
            }
            (Event::Observe, Step::FollowLatest) => {
                if !probe.is_some_and(|(_, view, _, _)| view.from_bottom < 1.0)
                    || agent.visual_reading_position().is_some()
                {
                    return observe();
                }
                self.step = Step::WaitForStream;
                stream(tab, "incoming-at-bottom")
            }
            (Event::Observe, Step::WaitForStream) => {
                let Some((_, view, _, _)) =
                    probe.filter(|(_, _, items, _)| *items == self.items + 3)
                else {
                    return observe();
                };
                assert!(view.from_bottom < 1.0, "latest reply did not stay visible");
                assert!(agent.visual_reading_position().is_none());
                let result = json!({
                    "kept_history_position_during_streaming": true,
                    "kept_history_position_at_widths": [900, 1320],
                    "followed_reply_when_at_bottom": true,
                });
                std::fs::write(
                    self.directory.join("reading-position.json"),
                    result.to_string(),
                )
                .expect("record streaming and resize results");
                self.step = Step::CaptureActivityIdle;
                let packet = json!({
                    "method": "turn/diff/updated",
                    "params": { "threadId": THREAD, "turnId": "image-turn", "diff": ACTIVITY_DIFF }
                });
                Task::done(Message::Agent(
                    tab.id,
                    agent::Action::Event(codex_rpc::Event::Packet(packet)),
                ))
                .chain(observe())
            }
            (Event::Activity(frame), Step::CaptureActivityIdle | Step::CaptureActivityHover) => {
                let hovered = matches!(self.step, Step::CaptureActivityHover);
                let (_, view, _, _) = probe.expect("activity viewport");
                let bounds = view.bounds;
                let (right, bottom) = activity_corner(bounds, frame.scale_factor);
                let scale = frame.scale_factor;
                let arrow = iced::Rectangle::new(
                    iced::Point::new(right - 21.0 * scale, bottom - 47.0 * scale),
                    Size::new(17.0 * scale, 27.0 * scale),
                );
                assert_eq!(
                    pixels_where(&frame, arrow, |[r, g, b]| r > 130 && g > 130 && b > 130) > 0,
                    hovered,
                    "activity chevron should be visible only on hover"
                );
                self.save(
                    if hovered {
                        "activity-hover.png"
                    } else {
                        "activity-idle.png"
                    },
                    frame,
                );
                self.step = if hovered {
                    Step::CaptureActivityExpanded
                } else {
                    Step::CaptureActivityHover
                };
                let x = (bounds.center_x() * scale).round() as i32;
                let y = (bottom - 33.0 * scale).round() as i32;
                window::latest()
                    .then(move |id| {
                        window::run(id.expect("active Span window"), move |window| {
                            if hovered {
                                scroll::Target::click(window, x, y);
                            } else {
                                scroll::Target::locate(window, x, y);
                            }
                        })
                        .discard()
                    })
                    .chain(observe())
            }
            (Event::Observe, Step::CaptureActivityIdle | Step::CaptureActivityHover) => {
                screenshot(Event::Activity)
            }
            (Event::Observe, Step::CaptureActivityExpanded) => {
                if agent.visual_activity_expanded("image-turn-diff") {
                    screenshot(Event::Activity)
                } else {
                    observe()
                }
            }
            (Event::Activity(frame), Step::CaptureActivityExpanded) => {
                let (_, view, _, _) = probe.expect("expanded activity viewport");
                let logical = view.bounds;
                let scale = frame.scale_factor;
                let bounds = iced::Rectangle::new(
                    iced::Point::new(logical.x * scale, logical.y * scale),
                    Size::new(logical.width * scale, logical.height * scale),
                );
                for color in [[0x20, 0x38, 0x2e], [0x40, 0x29, 0x30]] {
                    assert!(
                        pixels_where(&frame, bounds, |pixel| pixel == color) > 100,
                        "missing expanded diff line color {color:?}"
                    );
                }
                self.save("activity-diff.png", frame);
                std::fs::write(self.directory.join("activity.json"),
                    br#"{"hoverRevealsChevron":true,"clickedDiff":true,"addedAndRemovedRowsPainted":true}"#,
                ).expect("record native activity workflow");
                let fixture = self.directory.join("file-fixture");
                for folder in [
                    "mnt/data",
                    "mnt/logs",
                    "mnt/.cache",
                    "mnt/Internal",
                    "monitor",
                ] {
                    std::fs::create_dir_all(fixture.join(folder))
                        .expect("create directory fixture");
                }
                assert!(
                    std::process::Command::new("attrib.exe")
                        .arg("+H")
                        .arg(fixture.join("mnt/Internal"))
                        .status()
                        .expect("mark the fixture as hidden")
                        .success()
                );
                std::fs::write(
                    fixture.join("mnt/data.txt"),
                    "A file excluded from directory suggestions",
                )
                .expect("create file fixture");
                self.step = Step::OpenFileSidebar;
                Task::done(Message::Sidebar(crate::SidebarPage::Files)).chain(observe())
            }
            (Event::Observe, Step::OpenFileSidebar) => {
                if !tab
                    .file_panel
                    .as_ref()
                    .is_some_and(|panel| panel.visual_folder().is_some())
                {
                    return observe();
                }
                self.step = Step::WaitForPartialPath;
                self.type_directory(tab, "m")
            }
            (Event::Observe, Step::WaitForPartialPath) => {
                let panel = tab.file_panel.as_ref().expect("open file sidebar");
                if !panel.visual_matches().eq(["mnt", "monitor"]) {
                    return observe();
                }
                self.step = Step::WaitForExactPath;
                self.type_directory(tab, "mnt")
            }
            (Event::Observe, Step::WaitForExactPath) => {
                let panel = tab.file_panel.as_ref().expect("open file sidebar");
                if !panel.visual_matches().eq(["data", "logs"]) {
                    return observe();
                }
                assert_ne!(
                    panel.visual_folder().and_then(|path| path.file_name()),
                    Some(std::ffi::OsStr::new("mnt"))
                );
                self.step = Step::CaptureFileSuggestions;
                screenshot(Event::FileSuggestions)
            }
            (Event::FileSuggestions(frame), Step::CaptureFileSuggestions) => {
                let scale = frame.scale_factor;
                let x = (180.0 * scale) as u32;
                let top = (130.0 * scale) as u32;
                let bottom = (235.0 * scale) as u32;
                let suggestion_card = crate::theme::CHROME.into_rgba8();
                let y = (top..bottom).find(|y| {
                    let offset = ((y * frame.size.width + x) * 4) as usize;
                    frame.rgba.get(offset..offset + 3) == Some(&suggestion_card[..3])
                });
                self.save("file-suggestions.png", frame);
                let y = y.expect("painted directory suggestion card") + (16.0 * scale) as u32;
                self.step = Step::WaitForFolder { scale };
                window::latest()
                    .then(move |id| {
                        window::run(id.expect("active Span window"), move |window| {
                            scroll::Target::click(window, x as i32, y as i32);
                        })
                        .discard()
                    })
                    .chain(observe())
            }
            (Event::Observe, Step::WaitForFolder { scale }) => {
                let panel = tab.file_panel.as_ref().expect("open file sidebar");
                if !panel
                    .visual_folder()
                    .is_some_and(|path| path.ends_with("mnt/data"))
                {
                    return observe();
                }
                assert_eq!(panel.visual_matches().count(), 0);
                std::fs::remove_dir_all(self.directory.join("file-fixture"))
                    .expect("clean up temporary file fixture");
                std::fs::write(self.directory.join("file-suggestions.json"),
                    br#"{"partialPrefix":true,"exactPathShowsChildrenWithoutEnter":true,"hiddenAndFilesFiltered":true,"openedWithMouse":true}"#,
                ).expect("record native file suggestions");
                assert_eq!(sidebar, Some(SidebarPage::Files));
                assert!(tab.show_agent && !tab.show_drawer);
                self.step = Step::WaitForConnect;
                click_workspace(19.0, 130.0, scale)
            }
            (Event::Observe, Step::WaitForConnect) => {
                if !connecting {
                    return observe();
                }
                assert_eq!(sidebar, Some(SidebarPage::Files));
                assert!(tab.show_agent);
                self.step = Step::CaptureConnect;
                screenshot(Event::QuickConnect)
            }
            (Event::QuickConnect(frame), Step::CaptureConnect) => {
                self.save("quick-connect.png", frame);
                self.step = Step::WaitForDrawer;
                Task::done(Message::DismissPopup)
                    .chain(Task::done(Message::Command(WorkspaceCommand::Files)))
                    .chain(Task::done(Message::Command(WorkspaceCommand::Drawer)))
                    .chain(observe())
            }
            (Event::Observe, Step::WaitForDrawer) => {
                assert!(!connecting);
                assert_eq!(sidebar, Some(SidebarPage::Sessions));
                assert!(tab.show_agent && tab.show_drawer);
                if probe.is_none() || !matches!(tab.terminal, crate::TerminalState::Ready(_)) {
                    return observe();
                }
                self.step = Step::CaptureNavigation;
                screenshot(Event::WorkspaceNavigation)
            }
            (Event::WorkspaceNavigation(frame), Step::CaptureNavigation) => {
                let scale = frame.scale_factor;
                self.scale = Some(scale);
                self.save("workspace-navigation.png", frame);
                self.step = Step::WaitForMenu;
                click_workspace(222.0, 21.0, scale)
            }
            (Event::Observe, Step::WaitForMenu) => {
                if menu != Some(WorkspaceMenu::View) {
                    return observe();
                }
                self.step = Step::CaptureMenu;
                screenshot(Event::Menu)
            }
            (Event::Menu(frame), Step::CaptureMenu) => {
                let scale = frame.scale_factor;
                self.save("workspace-menu.png", frame);
                self.step = Step::WaitForMenuAction;
                click_workspace(233.0, 101.0, scale)
            }
            (Event::Observe, Step::WaitForMenuAction) => {
                if menu.is_some() || sidebar != Some(SidebarPage::Files) {
                    return observe();
                }
                assert!(tab.show_agent && tab.show_drawer);
                std::fs::write(
                    self.directory.join("workspace-navigation.json"),
                    br#"{"quickConnectOpenedFromRail":true,"filePageKeepsConversation":true,"fileShortcutReturnsToSessions":true,"terminalDrawerKeepsConversation":true,"viewMenuOpenedFilesWithMouse":true}"#,
                ).expect("record Windows workbench navigation");
                self.step = Step::WaitForHostSidebar;
                Task::done(Message::Sidebar(SidebarPage::Hosts)).chain(observe())
            }
            (Event::Observe, Step::WaitForHostSidebar) => {
                assert_eq!(sidebar, Some(SidebarPage::Hosts));
                self.step = Step::WaitForHostEditor;
                let scale = self.scale.expect("captured workbench scale");
                click_workspace(218.0, 106.0, scale)
            }
            (Event::Observe, Step::WaitForHostEditor) => {
                if !host_editor {
                    return observe();
                }
                self.step = Step::CaptureHostEditor;
                Task::done(Message::Hosts(host_panel::Action::Name(
                    "开发服务器".to_owned(),
                )))
                .chain(Task::done(Message::Hosts(host_panel::Action::Target(
                    "dev@workbench.example:2222".to_owned(),
                ))))
                .chain(screenshot(Event::HostEditor))
            }
            (Event::HostEditor(frame), Step::CaptureHostEditor) => {
                self.save("host-editor.png", frame);
                self.step = Step::WaitForSavedHost;
                Task::done(Message::Hosts(host_panel::Action::Confirm)).chain(observe())
            }
            (Event::Observe, Step::WaitForSavedHost) => {
                if host_editor {
                    return observe();
                }
                let profile = self.directory.join("profile-fixture/hosts.json");
                let json: Value = serde_json::from_slice(
                    &std::fs::read(profile).expect("saved Windows host profile"),
                )
                .expect("valid host profile");
                assert_eq!(
                    json,
                    json!([{"name":"开发服务器","target":"ssh://dev@workbench.example:2222"}])
                );
                assert!(tab.show_agent && tab.show_drawer);
                self.step = Step::CaptureHosts;
                screenshot(Event::Hosts)
            }
            (Event::Hosts(frame), Step::CaptureHosts) => {
                self.save("hosts.png", frame);
                Task::done(Message::CloseWindow)
            }
            (
                Event::Observe,
                Step::WaitForGoalMenu
                | Step::WaitForGoalDraft
                | Step::WaitForGoalText
                | Step::WaitForGoalSave,
            ) => observe(),
            _ => Task::none(),
        }
    }

    fn assert_reader(&self, agent: &agent::Agent) {
        let (expected, before) = self.reading.as_ref().expect("history reader");
        let (actual, after) = agent.visual_reading_position().expect("preserved reader");
        assert_eq!(&actual, expected, "viewport jumped to another message");
        assert!(
            (after - before).abs() <= 1.5,
            "message shifted from {before} to {after}"
        );
    }

    fn type_directory(&self, tab: &Tab, path: &str) -> Task<Message> {
        let address = self.directory.join("file-fixture").join(path);
        Task::done(Message::Files(
            tab.id,
            file_panel::Action::Path(address.to_string_lossy().into_owned()),
        ))
        .chain(observe())
    }

    fn save(&self, name: &str, frame: window::Screenshot) -> u64 {
        assert!(frame.size.width >= 760 && frame.size.height >= 480);
        let pixels = frame.rgba.as_ref();
        let mut hash = DefaultHasher::new();
        pixels.hash(&mut hash);
        image::save_buffer(
            self.directory.join(name),
            pixels,
            frame.size.width,
            frame.size.height,
            image::ColorType::Rgba8,
        )
        .expect("save native window screenshot");
        hash.finish()
    }
}

fn activity_corner(bounds: iced::Rectangle, scale: f32) -> (f32, f32) {
    let reading_width = (bounds.width - 48.0).min(760.0);
    (
        (bounds.x + (bounds.width + reading_width) / 2.0) * scale,
        (bounds.y + bounds.height) * scale,
    )
}

fn verify_typography() -> serde_json::Value {
    use iced::advanced::graphics::text::{
        cosmic_text::{Attrs, Buffer, Family, Metrics, Shaping},
        font_system,
    };

    let mut fonts = font_system().write().expect("Iced font system");
    let fonts = fonts.raw();
    let mut buffer = Buffer::new_empty(Metrics::new(15.0, 22.0));
    let mut resolve = |sample: &str, family: &str| {
        buffer.set_text(
            fonts,
            sample,
            &Attrs::new().family(Family::Name(family)),
            Shaping::Advanced,
            None,
        );
        let glyph = buffer
            .layout_runs()
            .next()
            .and_then(|run| run.glyphs.first())
            .expect("shaped sample");
        assert_ne!(glyph.glyph_id, 0, "substitute glyph for {sample}");
        let face = fonts.db().face(glyph.font_id).expect("resolved font face");
        face.families[0].0.clone()
    };
    let latin = resolve("Span", "Segoe UI");
    let chinese = resolve("简体中文", "Segoe UI");
    let code = resolve("fn", "Consolas");
    assert_eq!(latin, "Segoe UI");
    assert_eq!(code, "Consolas");
    json!({"latin": latin, "simplifiedChinese": chinese, "code": code})
}

fn pixels_where(
    frame: &window::Screenshot,
    bounds: iced::Rectangle,
    test: impl Fn([u8; 3]) -> bool,
) -> usize {
    let right = ((bounds.x + bounds.width).ceil() as u32).min(frame.size.width);
    let bottom = ((bounds.y + bounds.height).ceil() as u32).min(frame.size.height);
    let mut count = 0;
    for y in bounds.y as u32..bottom {
        for x in bounds.x as u32..right {
            let offset = ((y * frame.size.width + x) * 4) as usize;
            let pixel = [
                frame.rgba[offset],
                frame.rgba[offset + 1],
                frame.rgba[offset + 2],
            ];
            count += usize::from(test(pixel));
        }
    }
    count
}

fn resize(width: u32) -> Task<Message> {
    window::latest()
        .then(move |id| {
            window::resize(
                id.expect("active Span window"),
                Size::new(width as f32, 780.0),
            )
        })
        .chain(observe())
}

fn click_copy(bounds: iced::Rectangle, scale: f32, format: CopyFormat) -> Task<Message> {
    let reading_width = (bounds.width - 48.0).min(760.0);
    let right = bounds.x + (bounds.width + reading_width) / 2.0;
    let from_right = match format {
        CopyFormat::Markdown => 46.0,
        CopyFormat::RichText => 14.0,
    };
    let x = ((right - from_right) * scale).round() as i32;
    let y = ((bounds.y + bounds.height - 34.0) * scale).round() as i32;
    window::latest()
        .then(move |id| {
            window::run(id.expect("active Span window"), move |window| {
                scroll::Target::click(window, x, y);
            })
            .discard()
        })
        .chain(observe())
}

fn verify_copy(format: CopyFormat) {
    use clipboard_win::{Clipboard, formats, raw};
    let _clipboard = Clipboard::new_attempts(10).expect("read Windows clipboard");
    let markdown: String = clipboard_win::get(formats::Unicode).expect("read Unicode Markdown");
    assert_eq!(markdown, format!("{COPY_INTRO}\n\n{COPY_MARKDOWN}"));
    let html_format = formats::Html::new().expect("Windows HTML clipboard format");
    if format == CopyFormat::RichText {
        let html: String = clipboard_win::get(html_format).expect("read formatted HTML fragment");
        for fragment in [
            COPY_INTRO,
            "<table>",
            "<th>检查</th>",
            "<strong>通过</strong>",
            r#"<a href="https://example.invalid/build-report">Details</a>"#,
            "<pre><code",
            "span check --preview",
        ] {
            assert!(html.contains(fragment), "copy missing {fragment}: {html}");
        }
    } else {
        assert!(!raw::is_format_avail(html_format.code()));
    }
}

fn stream(tab: &Tab, item_id: &str) -> Task<Message> {
    let packet = json!({
        "method": "item/agentMessage/delta",
        "params": {
            "threadId": THREAD, "turnId": "image-turn", "itemId": item_id,
            "delta": "Streaming text expands the transcript at the bottom.\n".repeat(18)
        }
    });
    Task::done(Message::Agent(
        tab.id,
        agent::Action::Event(codex_rpc::Event::Packet(packet)),
    ))
    .chain(observe())
}

fn paste(tab: &Tab, value: &str) -> Task<Message> {
    Task::done(Message::Agent(
        tab.id,
        agent::Action::Draft(text_editor::Action::Edit(text_editor::Edit::Paste(
            Arc::new(value.into()),
        ))),
    ))
}

fn click_workspace(x: f32, y: f32, scale: f32) -> Task<Message> {
    window::latest()
        .then(move |id| {
            window::run(id.expect("active Span window"), move |window| {
                scroll::Target::click(window, (x * scale) as i32, (y * scale) as i32);
            })
            .discard()
        })
        .chain(observe())
}

fn screenshot(event: fn(window::Screenshot) -> Event) -> Task<Message> {
    window::latest().then(move |id| {
        window::screenshot(id.expect("active Span window"))
            .map(move |image| Message::Visual(event(image)))
    })
}

fn put_bitmap_on_clipboard() {
    let mut bitmap = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        80,
        48,
        image::Rgb([165, 187, 255]),
    ))
    .write_to(&mut bitmap, image::ImageFormat::Bmp)
    .expect("encode fixture bitmap");
    clipboard_win::set_clipboard(
        clipboard_win::formats::RawData(clipboard_win::formats::CF_DIB),
        &bitmap.into_inner()[14..],
    )
    .expect("copy the fixture bitmap to the live Windows clipboard");
}

pub async fn serve(mut input: mpsc::Receiver<Value>, output: &mut mpsc::Sender<codex_rpc::Event>) {
    let thread = json!({
        "id": THREAD,
        "name": "Make preview deployments repeatable",
        "cwd": r"C:\workspace\release-tools",
    });
    let mut goal = Value::Null;
    while let Some(request) = input.next().await {
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request["method"].as_str() {
            Some("initialize") => json!({"userAgent":"codex/0.167.0"}),
            Some("thread/list") => json!({"data":[thread]}),
            Some("thread/resume") => json!({
                "thread": thread,
                "model": "fixture",
                "reasoningEffort":"high",
                "sandbox":{"type":"workspaceWrite"},
                "approvalPolicy":"on-request",
                "initialTurnsPage":page(EARLIER_ITEMS, EARLIER_ITEMS + INITIAL_ITEMS, Some("older")),
            }),
            Some("thread/turns/list") => page(0, EARLIER_ITEMS, None),
            Some("thread/goal/get") => json!({"goal":goal}),
            Some("thread/goal/set") => {
                assert_eq!(
                    request["params"],
                    json!({
                        "threadId":THREAD, "origin":"user", "objective":OBJECTIVE, "status":"active"
                    })
                );
                goal = json!({"threadId":THREAD,"objective":OBJECTIVE,"status":"active"});
                json!({"goal":goal})
            }
            Some("model/list") => json!({"data":[{
                "model":"fixture",
                "displayName":"Codex · Fixture",
                "supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"high"}],
                "serviceTiers":[{"id":"priority"}],
            }]}),
            Some("turn/start") => {
                let inputs = request["params"]["input"].as_array().expect("turn inputs");
                assert_eq!(inputs.len(), 1, "send the image without placeholder text");
                assert_eq!(inputs[0]["type"], "image");
                let url = inputs[0]["url"].as_str().expect("image URL");
                let data = STANDARD
                    .decode(
                        url.strip_prefix("data:image/png;base64,")
                            .expect("inline PNG"),
                    )
                    .expect("decode the submitted image");
                let image = image::load_from_memory(&data)
                    .expect("decode the PNG received by Codex")
                    .into_rgb8();
                assert_eq!(image.dimensions(), (80, 48));
                assert_eq!(image.get_pixel(12, 12).0, [165, 187, 255]);
                let completed = json!({
                    "method":"item/completed",
                    "params": {
                        "threadId":THREAD,
                        "item":{"id":"clipboard-image","type":"userMessage","content":inputs}
                    }
                });
                if output
                    .send(codex_rpc::Event::Packet(completed))
                    .await
                    .is_err()
                {
                    break;
                }
                json!({"turn":{"id":"image-turn","status":"inProgress"}})
            }
            _ => Value::Null,
        };
        let message = codex_rpc::Event::Packet(json!({"id":id,"result":result}));
        if output.send(message).await.is_err() {
            break;
        }
    }
}

fn page(start: usize, end: usize, next: Option<&str>) -> Value {
    let turns: Vec<_> = (start..end)
        .step_by(4)
        .rev()
        .map(|turn| {
            let mut progress = json!({"id":format!("check-{turn}"),"type":"commandExecution",
                "command":"cargo test --workspace", "aggregatedOutput":"24 passed"});
            let mut reply = format!(
                "### Preview build {}\n\nThe **deployment** now reuses the same artifact on retry.\n\n- The validation stage completed successfully.\n- The preview stays available while a replacement is deployed, so readers can finish their work safely.\n\n```powershell\nspan check --preview {}\n```",
                turn + 1, turn + 1
            );
            if turn + 4 == EARLIER_ITEMS + INITIAL_ITEMS {
                progress = json!({"id":format!("check-{turn}"),"type":"agentMessage","text":COPY_INTRO});
                reply = COPY_MARKDOWN.into();
            }
            json!({
                "id":format!("turn-{turn}"),
                "status":"completed",
                "items":[
                    {"id":format!("user-{turn}"),"type":"userMessage","content":[
                        {"type":"text","text":format!("Review preview build **{}** and summarize what changed.", turn + 1)}
                    ]},
                    progress,
                    {"id":format!("reason-{turn}"),"type":"reasoning","summary":[
                        "Check the lockfile, then compare the deployment logs with the previous build."
                    ]},
                    {"id":format!("reply-{turn}"),"type":"agentMessage","text":reply},
                ],
            })
        })
        .collect();
    json!({"data":turns,"nextCursor":next})
}
