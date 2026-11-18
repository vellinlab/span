use gtk::glib::{self, translate::from_glib_full};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
use std::path::{Path, PathBuf};

pub const MAX_ENTRIES: usize = 10_000;

#[derive(Clone)]
pub enum Source {
    Local,
    Sftp { socket: Option<PathBuf> },
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
}

pub struct ControlSocket(PathBuf);

impl ControlSocket {
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
        if path.to_str().is_none() || path.as_os_str().as_bytes().len() > 85 {
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

pub struct Entry {
    pub name: OsString,
    pub kind: Kind,
    pub size: Option<u64>,
    pub modified: Option<i64>,
    pub mode: Option<u32>,
}

impl Entry {
    pub fn hidden(&self) -> bool {
        self.name.as_os_str().as_bytes().starts_with(b".")
    }
}

pub struct Directory {
    pub path: PathBuf,
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

fn list_local(path: Option<&Path>) -> io::Result<Directory> {
    let path = fs::canonicalize(path.map_or_else(glib::home_dir, Path::to_path_buf))?;
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
            kind: metadata
                .as_ref()
                .map_or(Kind::Other, |metadata| Kind::from_mode(metadata.mode())),
            size: metadata.as_ref().map(MetadataExt::size),
            modified: metadata.as_ref().map(MetadataExt::mtime),
            mode: metadata.as_ref().map(MetadataExt::mode),
        });
    }
    Ok(Directory {
        path,
        entries,
        truncated,
    })
}

pub fn display(value: &std::ffi::OsStr) -> String {
    value
        .to_string_lossy()
        .chars()
        .flat_map(|c| {
            if c.is_control() {
                c.escape_default().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect()
}
