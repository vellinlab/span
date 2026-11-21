use crate::{Message, Tab, agent, codex_rpc};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures::channel::mpsc;
use futures::{SinkExt, StreamExt};
use iced::widget::operation::{AbsoluteOffset, scroll_to};
use iced::{Task, window};
use serde_json::{Value, json};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Cursor;
use std::path::PathBuf;
use std::time::{Duration, Instant};

mod scroll;
pub use scroll::frames;
const DIRECTORY: &str = "SPAN_VISUAL_CHECK_DIR";
const THREAD: &str = "visual-check";
const INITIAL_ITEMS: usize = 320;
const EARLIER_ITEMS: usize = 32;

#[derive(Clone, Debug)]
pub enum Event {
    Observe,
    Latest(window::Screenshot),
    Earlier(window::Screenshot),
    Target(scroll::Target, f32),
    Frame(Instant),
    ScrollResults(Value),
    Attachment(window::Screenshot),
}

#[derive(Clone, Copy)]
enum Step {
    Open,
    CaptureLatest,
    WaitForHistory { end: f32 },
    CaptureEarlier { end: f32, actual: f32 },
    WaitForAttachment,
    CaptureAttachment,
    WaitForAttachmentReply,
}

pub struct Check {
    directory: PathBuf,
    step: Step,
    first_frame: u64,
    items: usize,
    benchmark: Option<scroll::Benchmark>,
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
        })
    }

    pub fn measuring(&self) -> bool {
        self.benchmark.is_some()
    }

    pub fn update(&mut self, event: Event, tab: Option<&Tab>) -> Task<Message> {
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
            Event::Frame(started) => {
                if let (Some(benchmark), Some((_, view, _, _))) = (&mut self.benchmark, probe) {
                    return benchmark.frame(started, view.absolute_offset().y);
                }
                return Task::none();
            }
            Event::ScrollResults(results) => {
                scroll::save(&self.directory, &results);
                self.benchmark = None;
                put_bitmap_on_clipboard();
                self.step = Step::WaitForAttachment;
                return Task::done(Message::Agent(tab.id, agent::Action::Paste)).chain(observe());
            }
            _ => {}
        }
        match (event, self.step) {
            (Event::Observe, Step::Open) => match probe {
                Some((_, view, INITIAL_ITEMS, true)) => {
                    assert!(view.absolute_offset().y < 1.0);
                    assert!(view.absolute_offset_reversed().y > 1_000.0);
                    self.step = Step::CaptureLatest;
                    screenshot(Event::Latest)
                }
                _ => Task::batch([
                    Task::done(Message::Agent(tab.id, agent::Action::Resume(THREAD.into()))),
                    observe(),
                ]),
            },
            (Event::Latest(frame), Step::CaptureLatest) => {
                self.first_frame = self.save("latest.png", frame);
                let (id, view, _, _) = probe.expect("latest viewport");
                let end = view.absolute_offset_reversed().y - 45.0;
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
                    let actual = view.absolute_offset().y;
                    if view.absolute_offset_reversed().y < 200.0 {
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
                let bounds = view.bounds();
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
                    std::fs::write(
                        self.directory.join("attachment.json"),
                        br#"{"clipboard":"CF_DIB","input":"inline PNG","accepted":true}"#,
                    )
                    .expect("record Windows clipboard attachment test");
                    Task::done(Message::CloseWindow)
                } else {
                    observe()
                }
            }
            _ => Task::none(),
        }
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
            json!({
                "id":format!("turn-{turn}"),
                "status":"completed",
                "items":[
                    {"id":format!("user-{turn}"),"type":"userMessage","content":[
                        {"type":"text","text":format!("Review preview build **{}** and summarize what changed.", turn + 1)}
                    ]},
                    {"id":format!("check-{turn}"),"type":"commandExecution",
                        "command":"cargo test --workspace", "aggregatedOutput":"24 passed"},
                    {"id":format!("reason-{turn}"),"type":"reasoning","summary":[
                        "Check the lockfile, then compare the deployment logs with the previous build."
                    ]},
                    {"id":format!("reply-{turn}"),"type":"agentMessage","text":format!(
                        "### Preview build {}\n\nThe **deployment** now reuses the same artifact on retry.\n\n- The validation stage completed successfully.\n- The preview stays available while a replacement is deployed.\n\n```powershell\nspan check --preview {}\n```",
                        turn + 1, turn + 1
                    )},
                ],
            })
        })
        .collect();
    json!({"data":turns,"nextCursor":next})
}
