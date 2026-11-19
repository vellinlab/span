#[cfg(unix)]
pub type Channel = std::path::Path;
#[cfg(unix)]
pub type ChannelBuf = std::path::PathBuf;

#[cfg(windows)]
pub type Channel = str;
#[cfg(windows)]
pub type ChannelBuf = String;

#[cfg(unix)]
pub const PROGRAM: &str = "/usr/bin/ssh";
#[cfg(windows)]
pub const PROGRAM: &str = "ssh.exe";

#[cfg(windows)]
pub const BACKGROUND: &[&str] = &[
    "-T",
    "-x",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=12",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ClearAllForwardings=yes",
];
