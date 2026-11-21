use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub fn aliases(home: &Path) -> Result<Vec<String>, String> {
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
    hosts.retain(|host| seen.insert(host.to_ascii_lowercase()));
    Ok(hosts)
}

fn read_ssh_config(
    path: &Path,
    directory: &Path,
    home: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    hosts: &mut Vec<String>,
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
        for argument in arguments(rest) {
            let value = argument.as_str();
            if is_host {
                if !value.starts_with('!') && !value.contains(['*', '?', '/', '\\', '@']) {
                    hosts.push(argument);
                }
            } else {
                let value = if cfg!(windows) {
                    value.replace('\\', "/")
                } else {
                    value.to_owned()
                };
                let pattern = if let Some(relative) = value.strip_prefix("~/") {
                    format!("{}/{relative}", escape_path(home))
                } else if Path::new(&value).is_absolute() {
                    value.to_owned()
                } else {
                    format!("{}/{value}", escape_path(directory))
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

fn escape_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if cfg!(windows) {
        glob::Pattern::escape(&path.replace('\\', "/"))
    } else {
        glob::Pattern::escape(&path)
    }
}

#[cfg(unix)]
fn arguments(rest: &str) -> Vec<String> {
    gtk::glib::shell_parse_argv(rest)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|arg| arg.into_string().ok())
        .collect()
}

#[cfg(windows)]
fn arguments(rest: &str) -> Vec<String> {
    // Windows SSH paths can use backslashes inside or outside double quotes.
    let mut args = Vec::new();
    let mut value = String::new();
    let mut quoted = false;
    let mut chars = rest.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => quoted = !quoted,
            '\\' if chars.peek() == Some(&'"') => value.push(chars.next().unwrap()),
            '#' if !quoted && value.is_empty() => break,
            c if c.is_ascii_whitespace() && !quoted => {
                if !value.is_empty() {
                    args.push(std::mem::take(&mut value));
                }
            }
            c => value.push(c),
        }
    }
    if quoted {
        return Vec::new();
    }
    if !value.is_empty() {
        args.push(value);
    }
    args
}
