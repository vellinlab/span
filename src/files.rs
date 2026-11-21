use crate::ssh::{Channel, ChannelBuf};
#[cfg(unix)]
use gtk::glib;
#[cfg(unix)]
use gtk::glib::translate::from_glib_full;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub const MAX_ENTRIES: usize = 10_000;

#[derive(Clone, PartialEq, Eq)]
pub enum Source {
    Local,
    Sftp { socket: Option<ChannelBuf> },
}

impl Source {
    pub fn list(&self, path: Option<&Path>) -> Result<Directory, String> {
        let mut directory = match self {
            Self::Local => list_local(path).map_err(|err| err.to_string())?,
            Self::Sftp {
                socket: Some(socket),
            } => crate::sftp::list(socket, path)?,
            Self::Sftp { socket: None } => return Err("本标签的 SSH 目录通道不可用。".into()),
        };
        directory.entries.sort_by_cached_key(|entry| {
            (
                entry.kind != Kind::Directory,
                entry.name.to_string_lossy().to_lowercase(),
            )
        });
        Ok(directory)
    }

    pub fn preview(&self, path: &Path, limit: usize) -> Result<Vec<u8>, String> {
        match self {
            Self::Local => {
                let mut data = Vec::new();
                open_file(path)?
                    .take(limit as u64 + 1)
                    .read_to_end(&mut data)
                    .map_err(file_error)?;
                if data.len() > limit {
                    return Err("文件超过预览大小上限。".into());
                }
                Ok(data)
            }
            Self::Sftp { .. } => crate::sftp::read_preview(self.socket()?, path, limit),
        }
    }

    pub fn upload(&self, local: &Path, destination: &Path) -> Result<(), String> {
        let mut input = open_file(local)?;
        match self {
            Self::Local => write_local(destination, false, |output| copy(&mut input, output)),
            Self::Sftp { .. } => crate::sftp::upload(self.socket()?, destination, &mut input),
        }
    }

    pub fn download(&self, source: &Path, local: &Path) -> Result<(), String> {
        write_local(local, true, |output| match self {
            Self::Local => copy(&mut open_file(source)?, output),
            Self::Sftp { .. } => crate::sftp::download(self.socket()?, source, output),
        })
    }

    fn socket(&self) -> Result<&Channel, String> {
        match self {
            Self::Sftp {
                socket: Some(socket),
            } => Ok(socket),
            _ => Err("本标签的 SSH 文件通道不可用。".into()),
        }
    }
}

fn open_file(path: &Path) -> Result<File, String> {
    if !fs::metadata(path).map_err(file_error)?.is_file() {
        return Err("请选择普通文件。".into());
    }
    let file = File::open(path).map_err(file_error)?;
    if !file.metadata().map_err(file_error)?.is_file() {
        return Err("请选择普通文件。".into());
    }
    Ok(file)
}

fn copy(input: &mut File, output: &mut File) -> Result<(), String> {
    io::copy(input, output).map(|_| ()).map_err(file_error)
}

fn write_local(
    destination: &Path,
    overwrite: bool,
    write: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    let temporary = destination.with_file_name(format!(".span-copy-{}", uuid::Uuid::new_v4()));
    let mut file = create_private_file(&temporary).map_err(file_error)?;
    let result = write(&mut file).and_then(|_| file.sync_all().map_err(file_error));
    drop(file);
    let result = result.and_then(|_| {
        if overwrite {
            fs::rename(&temporary, destination)
        } else {
            fs::hard_link(&temporary, destination)
        }
        .map_err(file_error)
    });
    let _ = fs::remove_file(temporary);
    result
}

fn file_error(error: io::Error) -> String {
    format!("本地文件操作失败：{error}")
}

pub fn create_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path)
}

pub struct ControlSocket(PathBuf);

impl ControlSocket {
    #[cfg(unix)]
    pub fn new() -> Option<Self> {
        // GLib creates an exclusive 0700 directory. Keep OpenSSH's socket inside it.
        let directory: Option<PathBuf> = unsafe {
            from_glib_full(glib::ffi::g_dir_make_tmp(
                c"swb-XXXXXX".as_ptr(),
                std::ptr::null_mut(),
            ))
        };
        let path = directory?.join("ssh");
        // OpenSSH briefly appends a suffix while binding the socket.
        if path.to_str().is_none_or(|path| path.contains(['%', '$']))
            || path.as_os_str().as_bytes().len() > 85
        {
            let _ = fs::remove_dir(path.parent()?);
            return None;
        }
        Some(Self(path))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ControlSocket {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        if let Some(directory) = self.0.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Directory,
    File,
    Symlink,
    Other,
}

impl Kind {
    pub fn from_mode(mode: u32) -> Self {
        match mode & 0o170000 {
            0o040000 => Self::Directory,
            0o100000 => Self::File,
            0o120000 => Self::Symlink,
            _ => Self::Other,
        }
    }
}

#[derive(PartialEq, Eq)]
pub struct Entry {
    pub name: OsString,
    pub kind: Kind,
    pub size: Option<u64>,
    pub modified: Option<i64>,
    pub mode: Option<u32>,
    #[cfg(windows)]
    pub windows_hidden: bool,
}

impl Entry {
    pub fn hidden(&self) -> bool {
        #[cfg(windows)]
        if self.windows_hidden {
            return true;
        }
        self.name.as_encoded_bytes().starts_with(b".")
    }
}

#[derive(PartialEq, Eq)]
pub struct Directory {
    pub path: PathBuf,
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

fn list_local(path: Option<&Path>) -> io::Result<Directory> {
    #[cfg(unix)]
    let default_path = || -> io::Result<PathBuf> { Ok(glib::home_dir()) };
    #[cfg(windows)]
    let default_path = || {
        std::env::home_dir()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "No home directory"))
    };
    let path = fs::canonicalize(path.map_or_else(default_path, |path| Ok(path.to_path_buf()))?)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in fs::read_dir(&path)? {
        let item = item?;
        if entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        let metadata = fs::symlink_metadata(item.path()).ok();
        entries.push(Entry {
            name: item.file_name(),
            kind: metadata.as_ref().map_or(Kind::Other, |metadata| {
                let kind = metadata.file_type();
                if kind.is_symlink() {
                    Kind::Symlink
                } else if kind.is_dir() {
                    Kind::Directory
                } else if kind.is_file() {
                    Kind::File
                } else {
                    Kind::Other
                }
            }),
            size: metadata.as_ref().map(fs::Metadata::len),
            modified: metadata.as_ref().and_then(last_modified),
            #[cfg(unix)]
            mode: metadata.as_ref().map(MetadataExt::mode),
            #[cfg(windows)]
            mode: None,
            #[cfg(windows)]
            windows_hidden: metadata
                .as_ref()
                .is_some_and(|meta| meta.file_attributes() & 0x2 != 0),
        });
    }
    Ok(Directory {
        path,
        entries,
        truncated,
    })
}

fn last_modified(metadata: &fs::Metadata) -> Option<i64> {
    #[cfg(unix)]
    return Some(metadata.mtime());
    #[cfg(windows)]
    return metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs()
        .try_into()
        .ok();
}

pub fn display(value: &std::ffi::OsStr) -> String {
    let value = value.to_string_lossy();
    let mut text = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_control() {
            text.extend(c.escape_default());
        } else {
            text.push(c);
        }
    }
    text
}
