use crate::files::{Directory, Entry, Kind, MAX_ENTRIES};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const INIT: u8 = 1;
const VERSION: u8 = 2;
const CLOSE: u8 = 4;
const OPENDIR: u8 = 11;
const READDIR: u8 = 12;
const REALPATH: u8 = 16;
const STATUS: u8 = 101;
const HANDLE: u8 = 102;
const NAME: u8 = 104;
const MAX_PACKET: usize = 256 * 1024;

pub fn list(socket: &Path, path: Option<&Path>) -> Result<Directory, String> {
    if !socket_ready(socket) {
        return Err("请在终端完成 SSH 登录，然后刷新目录。".into());
    }

    // Clear the user config for this channel. The shell already used it to establish
    // the transport. A failed multiplex request must not start another connection.
    let mut child = Command::new("/usr/bin/timeout")
        .args([
            "--kill-after=1s",
            "15s",
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
        ])
        .arg(socket)
        .args(["-s", "--", "localhost", "sftp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("无法启动系统 OpenSSH：{err}"))?;
    let result = Sftp::start(
        child.stdout.take().expect("piped SFTP stdout"),
        child.stdin.take().expect("piped SFTP stdin"),
    )
    .map_err(|_| "无法打开 SFTP 通道。请确认 SSH 仍在线，且服务器允许 SFTP。".to_owned())
    .and_then(|mut connection| connection.directory(path));
    let _ = child.wait();
    result
}

pub fn socket_ready(socket: &Path) -> bool {
    fs::symlink_metadata(socket).is_ok_and(|meta| meta.file_type().is_socket())
}

struct Sftp<R, W> {
    input: R,
    output: W,
    id: u32,
}

impl<R: Read, W: Write> Sftp<R, W> {
    fn start(input: R, output: W) -> Result<Self, String> {
        let mut connection = Self {
            input,
            output,
            id: 0,
        };
        connection.send(&[INIT, 0, 0, 0, 3])?;
        let mut packet = connection.receive()?;
        if packet.byte()? != VERSION || packet.u32()? != 3 {
            return Err("服务器未提供 SFTP v3。".into());
        }
        Ok(connection)
    }

    fn directory(&mut self, path: Option<&Path>) -> Result<Directory, String> {
        let requested = path.map_or(b".".as_slice(), |path| path.as_os_str().as_bytes());
        let (kind, mut packet) = self.request(REALPATH, requested)?;
        if kind != NAME {
            return Err(unexpected(kind, packet, "无法解析目录"));
        }
        if packet.u32()? != 1 {
            return Err("SFTP 返回了无效的目录路径。".into());
        }
        let bytes = packet.string()?;
        if !bytes.starts_with(b"/") || bytes.contains(&0) {
            return Err("SFTP 返回了无效的目录路径。".into());
        }
        let path = PathBuf::from(OsString::from_vec(bytes.to_vec()));

        let (kind, mut packet) = self.request(OPENDIR, path.as_os_str().as_bytes())?;
        if kind != HANDLE {
            return Err(unexpected(kind, packet, "无法打开目录"));
        }
        let handle = packet.string()?.to_vec();
        let mut entries = Vec::new();
        let mut truncated = false;
        loop {
            let (kind, mut packet) = self.request(READDIR, &handle)?;
            if kind == STATUS && packet.status_code()? == 1 {
                break;
            }
            if kind != NAME {
                return Err(unexpected(kind, packet, "无法读取目录"));
            }
            let count = packet.u32()? as usize;
            if count == 0 || count > MAX_PACKET / 12 {
                return Err("SFTP 返回了无效的目录条目数。".into());
            }
            for _ in 0..count {
                if let Some(entry) = packet.entry()? {
                    if entries.len() == MAX_ENTRIES {
                        truncated = true;
                        break;
                    }
                    entries.push(entry);
                }
            }
            if truncated {
                break;
            }
        }
        let _ = self.request(CLOSE, &handle);
        Ok(Directory {
            path,
            entries,
            truncated,
        })
    }

    fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.output
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .map_err(transport)?;
        self.output.write_all(bytes).map_err(transport)?;
        self.output.flush().map_err(transport)
    }

    fn receive(&mut self) -> Result<Packet, String> {
        let mut size = [0; 4];
        self.input.read_exact(&mut size).map_err(transport)?;
        let size = u32::from_be_bytes(size) as usize;
        if !(1..=MAX_PACKET).contains(&size) {
            return Err("SFTP 数据包长度无效。".into());
        }
        let mut bytes = vec![0; size];
        self.input.read_exact(&mut bytes).map_err(transport)?;
        Ok(Packet { bytes, offset: 0 })
    }

    fn request(&mut self, kind: u8, value: &[u8]) -> Result<(u8, Packet), String> {
        if value.len() > MAX_PACKET - 9 {
            return Err("SFTP 路径过长。".into());
        }
        self.id += 1;
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&self.id.to_be_bytes());
        bytes.extend_from_slice(&(value.len() as u32).to_be_bytes());
        bytes.extend_from_slice(value);
        self.send(&bytes)?;
        let mut reply = self.receive()?;
        let kind = reply.byte()?;
        if reply.u32()? != self.id {
            return Err("SFTP 响应编号不匹配。".into());
        }
        Ok((kind, reply))
    }
}

struct Packet {
    bytes: Vec<u8>,
    offset: usize,
}

impl Packet {
    fn take(&mut self, size: usize) -> Result<&[u8], String> {
        let start = self.offset;
        let end = start.saturating_add(size);
        let slice = self.bytes.get(start..end).ok_or("SFTP 数据包不完整。")?;
        self.offset = end;
        Ok(slice)
    }

    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn string(&mut self) -> Result<&[u8], String> {
        let size = self.u32()? as usize;
        self.take(size)
    }

    fn status_code(&self) -> Result<u32, String> {
        let mut header = [0; 4];
        let bytes = self
            .bytes
            .get(self.offset..self.offset + 4)
            .ok_or("SFTP 状态数据不完整。")?;
        header.copy_from_slice(bytes);
        Ok(u32::from_be_bytes(header))
    }

    fn entry(&mut self) -> Result<Option<Entry>, String> {
        let name = self.string()?.to_vec();
        self.string()?; // v3's human-readable longname is not authoritative metadata.
        let flags = self.u32()?;
        let size = if flags & 1 != 0 {
            Some(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
        } else {
            None
        };
        if flags & 2 != 0 {
            self.take(8)?; // uid, gid
        }
        let mode = if flags & 4 != 0 {
            Some(self.u32()?)
        } else {
            None
        };
        let modified = if flags & 8 != 0 {
            self.u32()?; // atime
            Some(i64::from(self.u32()?))
        } else {
            None
        };
        if flags & 0x8000_0000 != 0 {
            let count = self.u32()? as usize;
            for _ in 0..count {
                self.string()?;
                self.string()?;
            }
        }
        if name.is_empty()
            || name.len() > 4096
            || name == b"."
            || name == b".."
            || name.contains(&b'/')
            || name.contains(&0)
        {
            return Ok(None);
        }
        Ok(Some(Entry {
            name: OsString::from_vec(name),
            kind: mode.map_or(Kind::Other, Kind::from_mode),
            size,
            modified,
            mode,
        }))
    }
}

fn unexpected(kind: u8, packet: Packet, context: &str) -> String {
    let detail = if kind == STATUS {
        match packet.status_code() {
            Ok(2) => "目录不存在",
            Ok(3) => "权限不足",
            Ok(6 | 7) => "SSH 已断开",
            _ => "SFTP 操作失败",
        }
    } else {
        "SFTP 响应类型错误"
    };
    format!("{context}：{detail}。")
}

fn transport(err: io::Error) -> String {
    format!("读取 SFTP 目录失败：{err}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_files_through_an_existing_ssh_session() {
        let Some(socket) = std::env::var_os("WORKBENCH_TEST_SFTP_SOCKET") else {
            return;
        };
        let directory = PathBuf::from(std::env::var_os("WORKBENCH_TEST_SFTP_DIRECTORY").unwrap());
        let listing = list(Path::new(&socket), Some(&directory)).unwrap();
        assert_eq!(listing.path, directory);
        let file = listing
            .entries
            .iter()
            .find(|entry| entry.name == "a sample.txt")
            .unwrap();
        assert!(file.kind == Kind::File);
        assert_eq!(file.size, Some(3));
        assert_eq!(file.mode.unwrap() & 0o777, 0o640);
        assert!(file.modified.is_some());
        assert!(
            listing
                .entries
                .iter()
                .any(|entry| entry.kind == Kind::Directory && entry.name == "folder")
        );
        assert!(listing.entries.iter().any(|entry| entry.hidden()));
        assert!(
            list(
                Path::new(&socket),
                Some(&directory.join("missing-directory"))
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_oversized_and_truncated_packets() {
        let mut input = [0xFF, 0xFF, 0xFF, 0xFF].as_slice();
        assert!(Sftp::start(&mut input, Vec::new()).is_err());
        let mut broken = Packet {
            bytes: vec![0, 0, 0, 5, b'a'],
            offset: 0,
        };
        assert!(broken.string().is_err());
    }
}
