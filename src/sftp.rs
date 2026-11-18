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
const OPEN: u8 = 3;
const CLOSE: u8 = 4;
const READ: u8 = 5;
const WRITE: u8 = 6;
const OPENDIR: u8 = 11;
const READDIR: u8 = 12;
const REMOVE: u8 = 13;
const MKDIR: u8 = 14;
const RMDIR: u8 = 15;
const REALPATH: u8 = 16;
const STATUS: u8 = 101;
const HANDLE: u8 = 102;
const DATA: u8 = 103;
const NAME: u8 = 104;
const MAX_PACKET: usize = 256 * 1024;

pub fn list(socket: &Path, path: Option<&Path>) -> Result<Directory, String> {
    through_socket(socket, "15s", |sftp| sftp.directory(path))
}

pub fn read_image(socket: &Path, path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    through_socket(socket, "15s", |sftp| sftp.read_file(path, limit))
}

pub fn upload_attachments(
    socket: &Path,
    files: &[(String, Vec<u8>)],
) -> Result<Vec<PathBuf>, String> {
    if files
        .iter()
        .any(|(name, _)| name.is_empty() || name.contains(['/', '\0']))
    {
        return Err("附件名称无效。".into());
    }
    let directory = Path::new("/tmp").join(format!("span-{}", gtk::glib::uuid_string_random()));
    through_socket(socket, "60s", |sftp| {
        let mut payload = string_payload(directory.as_os_str().as_bytes())?;
        payload.extend_from_slice(&4u32.to_be_bytes()); // SSH_FILEXFER_ATTR_PERMISSIONS
        payload.extend_from_slice(&0o700u32.to_be_bytes());
        let result = sftp.request_payload(MKDIR, &payload)?;
        success(result, "无法创建远端附件目录")?;
        let mut uploaded = Vec::new();
        for (index, (name, data)) in files.iter().enumerate() {
            let path = directory.join(format!("{:02}-{name}", index + 1));
            let result = sftp.write_file(&path, data);
            uploaded.push(path);
            if let Err(error) = result {
                for path in &uploaded {
                    let _ = sftp.request(REMOVE, path.as_os_str().as_bytes());
                }
                let _ = sftp.request(RMDIR, directory.as_os_str().as_bytes());
                return Err(error);
            }
        }
        Ok(uploaded)
    })
}

fn through_socket<T>(
    socket: &Path,
    timeout: &str,
    action: impl FnOnce(
        &mut Sftp<std::process::ChildStdout, std::process::ChildStdin>,
    ) -> Result<T, String>,
) -> Result<T, String> {
    if !socket_ready(socket) {
        return Err("请在终端完成 SSH 登录，然后刷新目录。".into());
    }

    // Clear the user config for this channel. The shell already used it to establish
    // the transport. A failed multiplex request must not start another connection.
    let mut child = Command::new("/usr/bin/timeout")
        .args([
            "--kill-after=1s",
            timeout,
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
    .and_then(|mut connection| action(&mut connection));
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

    fn read_file(&mut self, path: &Path, limit: usize) -> Result<Vec<u8>, String> {
        let mut payload = string_payload(path.as_os_str().as_bytes())?;
        payload.extend_from_slice(&1u32.to_be_bytes()); // SSH_FXF_READ
        payload.extend_from_slice(&0u32.to_be_bytes()); // no attributes
        let (kind, mut packet) = self.request_payload(OPEN, &payload)?;
        if kind != HANDLE {
            return Err(unexpected(kind, packet, "无法打开图片"));
        }
        let handle = packet.string()?.to_vec();
        let mut image = Vec::new();
        loop {
            let mut payload = string_payload(&handle)?;
            payload.extend_from_slice(&(image.len() as u64).to_be_bytes());
            payload.extend_from_slice(&65536u32.to_be_bytes());
            let (kind, mut packet) = self.request_payload(READ, &payload)?;
            if kind == STATUS && packet.status_code()? == 1 {
                break;
            }
            if kind != DATA {
                return Err(unexpected(kind, packet, "无法读取图片"));
            }
            let chunk = packet.string()?;
            if chunk.is_empty() || image.len() + chunk.len() > limit {
                return Err("图片大小超出预览上限，或服务器返回了空数据。".into());
            }
            image.extend_from_slice(chunk);
        }
        let _ = self.request(CLOSE, &handle);
        Ok(image)
    }

    fn write_file(&mut self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        let mut payload = string_payload(path.as_os_str().as_bytes())?;
        payload.extend_from_slice(&42u32.to_be_bytes()); // SSH_FXF_WRITE | CREAT | EXCL
        payload.extend_from_slice(&4u32.to_be_bytes()); // SSH_FILEXFER_ATTR_PERMISSIONS
        payload.extend_from_slice(&0o600u32.to_be_bytes());
        let (kind, mut packet) = self.request_payload(OPEN, &payload)?;
        if kind != HANDLE {
            return Err(unexpected(kind, packet, "无法创建远端附件"));
        }
        let handle = packet.string()?.to_vec();
        let result = self.write_chunks(&handle, bytes);
        let close = self.request(CLOSE, &handle);
        result.and_then(|_| success(close?, "无法完成远端附件写入"))
    }

    fn write_chunks(&mut self, handle: &[u8], bytes: &[u8]) -> Result<(), String> {
        let handle = string_payload(handle)?;
        const CHUNK: usize = 96 * 1024;
        for (index, data) in bytes.chunks(CHUNK).enumerate() {
            let mut payload = handle.clone();
            payload.extend_from_slice(&((index * CHUNK) as u64).to_be_bytes());
            payload.extend_from_slice(&(data.len() as u32).to_be_bytes());
            payload.extend_from_slice(data);
            success(self.request_payload(WRITE, &payload)?, "无法写入远端附件")?;
        }
        Ok(())
    }

    fn request(&mut self, kind: u8, value: &[u8]) -> Result<(u8, Packet), String> {
        self.request_payload(kind, &string_payload(value)?)
    }

    fn request_payload(&mut self, kind: u8, payload: &[u8]) -> Result<(u8, Packet), String> {
        self.id += 1;
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&self.id.to_be_bytes());
        bytes.extend_from_slice(payload);
        self.send(&bytes)?;
        let mut reply = self.receive()?;
        let kind = reply.byte()?;
        if reply.u32()? != self.id {
            return Err("SFTP 响应编号不匹配。".into());
        }
        Ok((kind, reply))
    }
}

fn string_payload(value: &[u8]) -> Result<Vec<u8>, String> {
    if value.len() > MAX_PACKET - 32 {
        return Err("SFTP 路径或句柄过长。".into());
    }
    let mut payload = Vec::with_capacity(4 + value.len());
    payload.extend_from_slice(&(value.len() as u32).to_be_bytes());
    payload.extend_from_slice(value);
    Ok(payload)
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

fn success((kind, packet): (u8, Packet), context: &str) -> Result<(), String> {
    if kind == STATUS && packet.status_code()? == 0 {
        Ok(())
    } else {
        Err(unexpected(kind, packet, context))
    }
}

fn transport(err: io::Error) -> String {
    format!("SFTP 通信失败：{err}")
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
        assert_eq!(
            read_image(Path::new(&socket), &directory.join("a sample.txt"), 3).unwrap(),
            b"abc"
        );
        assert!(read_image(Path::new(&socket), &directory.join("a sample.txt"), 2).is_err());
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

    #[test]
    fn uploads_files_privately_through_an_existing_ssh_session() {
        use std::os::unix::fs::PermissionsExt;
        let Some(socket) = std::env::var_os("WORKBENCH_TEST_SFTP_SOCKET") else {
            return;
        };
        let contents = vec![0xAB; 210 * 1024];
        let files = vec![
            ("report.pdf".into(), contents),
            ("空.txt".into(), Vec::new()),
        ];
        let uploaded = upload_attachments(Path::new(&socket), &files).unwrap();
        let folder = uploaded[0].parent().unwrap();
        assert_eq!(
            fs::metadata(folder).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for (path, (_, expected)) in uploaded.iter().zip(files) {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(fs::read(path).unwrap(), expected);
            fs::remove_file(path).unwrap();
        }
        fs::remove_dir(folder).unwrap();
    }
}
