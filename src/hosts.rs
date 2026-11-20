use gtk::glib;
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Host {
    pub name: String,
    pub target: String,
    pub trusted_x11: bool,
}

impl Host {
    pub fn new(name: &str, target: &str, trusted_x11: bool) -> Result<Self, &'static str> {
        let target = target.trim();
        if target.is_empty()
            || target.starts_with('-')
            || target.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err("请输入 SSH 别名、地址或 user@host。");
        }
        let name = name.trim();
        if name.chars().any(char::is_control) {
            return Err("主机名称不能包含控制字符。");
        }

        Ok(Self {
            name: if name.is_empty() { target } else { name }.into(),
            target: target.into(),
            trusted_x11,
        })
    }
}

pub fn path() -> PathBuf {
    glib::user_config_dir().join("ssh-workbench/hosts.ini")
}

pub fn load(path: &Path) -> Result<Vec<Host>, String> {
    let data = match fs::read_to_string(path) {
        Ok(data) => data,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    decode(&data)
}

pub fn ssh_aliases(home: &Path) -> Result<Vec<Host>, String> {
    let directory = home.join(".ssh");
    let mut hosts = Vec::new();
    read_ssh_config(
        &directory.join("config"),
        &directory,
        home,
        0,
        &mut HashSet::new(),
        &mut hosts,
    )?;
    let mut seen = HashSet::new();
    hosts.retain(|host| seen.insert(host.target.to_ascii_lowercase()));
    Ok(hosts)
}

fn read_ssh_config(
    path: &Path,
    directory: &Path,
    home: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    hosts: &mut Vec<Host>,
) -> Result<(), String> {
    if depth >= 16 {
        return Err(format!("SSH 配置的 Include 嵌套过深：{}", path.display()));
    }
    let resolved = match path.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("{}：{error}", path.display())),
    };
    if !resolved.is_file() || !visited.insert(resolved.clone()) {
        return Ok(());
    }
    let config =
        fs::read_to_string(resolved).map_err(|error| format!("{}：{error}", path.display()))?;
    for line in config.lines().map(str::trim_start) {
        let end = line
            .find(|c: char| c.is_ascii_whitespace() || c == '=')
            .unwrap_or(line.len());
        let (key, rest) = line.split_at(end);
        let is_host = key.eq_ignore_ascii_case("host");
        if !is_host && !key.eq_ignore_ascii_case("include") {
            continue;
        }
        let rest = rest.trim_start();
        let rest = rest.strip_prefix('=').unwrap_or(rest);
        let Ok(arguments) = glib::shell_parse_argv(rest) else {
            continue;
        };
        for value in arguments.iter().filter_map(|arg| arg.to_str()) {
            if is_host {
                if !value.starts_with('!') && !value.contains(['*', '?', '/', '\\', '@']) {
                    hosts.extend(Host::new("", value, false).ok());
                }
            } else {
                let pattern = if let Some(relative) = value.strip_prefix("~/") {
                    format!(
                        "{}/{relative}",
                        glob::Pattern::escape(&home.to_string_lossy())
                    )
                } else if Path::new(value).is_absolute() {
                    value.to_owned()
                } else {
                    format!(
                        "{}/{value}",
                        glob::Pattern::escape(&directory.to_string_lossy())
                    )
                };
                let paths = glob::glob_with(
                    &pattern,
                    glob::MatchOptions {
                        require_literal_leading_dot: true,
                        ..glob::MatchOptions::new()
                    },
                )
                .map_err(|error| format!("{}：{error}", path.display()))?;
                for included in paths {
                    let included = included.map_err(|error| error.to_string())?;
                    read_ssh_config(&included, directory, home, depth + 1, visited, hosts)?;
                }
            }
        }
    }
    Ok(())
}

fn decode(data: &str) -> Result<Vec<Host>, String> {
    let file = glib::KeyFile::new();
    file.load_from_data(data, glib::KeyFileFlags::NONE)
        .map_err(|error| error.to_string())?;
    if file.integer("Workbench", "version").ok() != Some(1) {
        return Err("无法识别主机配置版本。".into());
    }

    file.groups()
        .iter()
        .filter(|group| group.starts_with("Host "))
        .map(|group| -> Result<Host, String> {
            let name = file.string(group, "name").map_err(|e| e.to_string())?;
            let target = file.string(group, "target").map_err(|e| e.to_string())?;
            let x11 = file
                .boolean(group, "trusted-x11")
                .map_err(|e| e.to_string())?;
            Host::new(&name, &target, x11).map_err(str::to_owned)
        })
        .collect()
}

pub fn save(path: &Path, hosts: &[Host]) -> Result<(), String> {
    let directory = path.parent().expect("host config directory");
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    glib::file_set_contents(path, encode(hosts).as_bytes()).map_err(|error| error.to_string())
}

fn encode(hosts: &[Host]) -> glib::GString {
    let file = glib::KeyFile::new();
    file.set_integer("Workbench", "version", 1);
    for (index, host) in hosts.iter().enumerate() {
        let group = format!("Host {}", index + 1);
        file.set_string(&group, "name", &host.name);
        file.set_string(&group, "target", &host.target);
        file.set_boolean(&group, "trusted-x11", host.trusted_x11);
    }
    file.to_data()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_profile_starts_with_no_hosts() {
        let nonexistent = std::env::temp_dir().join(glib::uuid_string_random().as_str());
        assert!(load(&nonexistent).unwrap().is_empty());
    }

    #[test]
    fn hosts_keep_order_names_and_x11_settings() {
        let hosts = [
            Host::new("东京 \\ 开发", "dev@tokyo", true).unwrap(),
            Host::new("", "build", false).unwrap(),
            Host::new("Tokyo 跳板", "tokyo", false).unwrap(),
        ];
        assert_eq!(decode(&encode(&hosts)).unwrap(), hosts);
        assert!(decode(&encode(&[])).unwrap().is_empty());
    }

    #[test]
    fn invalid_targets_and_config_are_rejected() {
        for target in ["", "-oProxyCommand=foo", "host a", "host\0a"] {
            assert!(Host::new("", target, false).is_err());
        }
        assert!(decode("[Workbench]\nversion=2").is_err());
        assert!(decode("[Workbench]\nversion=1\n[Host 1]\nname=a\ntarget=b").is_err());
    }
}
