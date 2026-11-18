use gtk::gio::{self, prelude::*};
use gtk::glib;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::path::Path;
use std::rc::Rc;

pub struct Rpc {
    process: gio::Subprocess,
    stdin: gio::OutputStream,
    queue: RefCell<VecDeque<Vec<u8>>>,
    writing: Cell<bool>,
    next_id: Cell<u64>,
    receive: Box<dyn Fn(Result<Value, String>)>,
}

impl Rpc {
    pub fn start(
        socket: Option<&Path>,
        receive: impl Fn(Result<Value, String>) + 'static,
    ) -> Result<Rc<Self>, String> {
        let mut argv: Vec<&OsStr> = Vec::new();
        if let Some(socket) = socket {
            argv.extend(
                [
                    "/usr/bin/ssh",
                    "-F",
                    "/dev/null",
                    "-T",
                    "-x",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ProxyCommand=/bin/false",
                    "-S",
                ]
                .map(OsStr::new),
            );
            argv.push(socket.as_os_str());
            argv.extend(["--", "localhost", "bash -lc 'exec codex app-server'"].map(OsStr::new));
        } else {
            argv.extend(["codex", "app-server"].map(OsStr::new));
        }

        let launcher = gio::SubprocessLauncher::new(
            gio::SubprocessFlags::STDIN_PIPE
                | gio::SubprocessFlags::STDOUT_PIPE
                | gio::SubprocessFlags::STDERR_SILENCE,
        );
        let process = launcher
            .spawn(&argv)
            .map_err(|e| format!("无法启动 Codex：{e}"))?;
        let stdin = process.stdin_pipe().expect("Codex stdin pipe");
        let stdout = gio::DataInputStream::new(&process.stdout_pipe().expect("Codex stdout pipe"));
        let rpc = Rc::new(Self {
            process,
            stdin,
            queue: RefCell::new(VecDeque::new()),
            writing: Cell::new(false),
            next_id: Cell::new(0),
            receive: Box::new(receive),
        });
        let weak = Rc::downgrade(&rpc);
        glib::MainContext::default().spawn_local(async move {
            loop {
                let read = stdout.read_line_future(glib::Priority::DEFAULT).await;
                let Some(rpc) = weak.upgrade() else { break };
                match read {
                    Ok(Some(bytes)) if bytes.len() <= 16 * 1024 * 1024 => {
                        if let Ok(message) = serde_json::from_slice(&bytes) {
                            (rpc.receive)(Ok(message));
                        }
                    }
                    Ok(Some(_)) => (rpc.receive)(Err("Codex 事件超过大小上限。".into())),
                    Ok(None) => {
                        (rpc.receive)(Err(
                            "Codex 已退出。请检查该主机上的 Codex CLI 和登录状态。".into()
                        ));
                        break;
                    }
                    Err(error) => {
                        (rpc.receive)(Err(format!("Codex 连接中断：{error}")));
                        break;
                    }
                }
            }
        });
        Ok(rpc)
    }

    pub fn request(self: &Rc<Self>, method: &str, params: Value) -> u64 {
        let id = self.next_id.get() + 1;
        self.next_id.set(id);
        self.enqueue(json!({"id": id, "method": method, "params": params}));
        id
    }

    pub fn notify(self: &Rc<Self>, method: &str) {
        self.enqueue(json!({"method": method}));
    }

    pub fn reply(self: &Rc<Self>, id: Value, result: Value) {
        self.enqueue(json!({"id": id, "result": result}));
    }

    pub fn unsupported(self: &Rc<Self>, id: Value) {
        self.enqueue(json!({"id": id, "error": {"code": -32601, "message": "This client does not implement this request"}}));
    }

    fn enqueue(self: &Rc<Self>, value: Value) {
        let mut line = value.to_string().into_bytes();
        line.push(b'\n');
        self.queue.borrow_mut().push_back(line);
        if self.writing.replace(true) {
            return;
        }
        let weak = Rc::downgrade(self);
        glib::MainContext::default().spawn_local(async move {
            while let Some(rpc) = weak.upgrade() {
                let Some(line) = rpc.queue.borrow_mut().pop_front() else {
                    rpc.writing.set(false);
                    break;
                };
                let stdin = rpc.stdin.clone();
                drop(rpc);
                let write = stdin.write_all_future(line, glib::Priority::DEFAULT).await;
                if let Some(rpc) = weak.upgrade() {
                    let error = match write {
                        Ok((_, _, error)) => error,
                        Err((_, error)) => Some(error),
                    };
                    if let Some(error) = error {
                        rpc.writing.set(false);
                        (rpc.receive)(Err(format!("无法向 Codex 发送消息：{error}")));
                        break;
                    }
                }
            }
        });
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        self.process.force_exit();
    }
}
