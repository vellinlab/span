use crate::{ssh_config, ssh_destination, theme};
use iced::widget::{
    Space, button, checkbox, column, container, opaque, row, scrollable, text, text_input,
};
use iced::{Center, Color, Element, Fill, Task, widget};
use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Host {
    pub name: String,
    pub target: String,
}

impl Host {
    fn new(name: &str, target: &str) -> Result<Self, &'static str> {
        let target =
            ssh_destination::normalize(target).ok_or("请输入 SSH 别名或 user@host:2222。")?;
        let name = name.trim();
        if name.chars().any(char::is_control) {
            return Err("主机名称不能包含控制字符。");
        }
        Ok(Self {
            name: if name.is_empty() {
                ssh_destination::label(&target).to_owned()
            } else {
                name.to_owned()
            },
            target,
        })
    }
}

#[derive(Clone, Debug)]
pub enum Action {
    Add,
    Edit(usize),
    Search(String),
    Name(String),
    Target(String),
    Confirm,
    AskDelete(usize),
    Import,
    Imported(Uuid, Result<Vec<String>, String>),
    SelectAlias(usize, bool),
    Connect(Host),
    ConnectRecent(String),
    Dismiss,
}

enum Dialog {
    Edit {
        index: Option<usize>,
        name: String,
        target: String,
    },
    Delete(usize),
    Reading(Uuid),
    Import(Vec<(Host, bool)>),
}

pub struct Panel {
    path: Option<PathBuf>,
    hosts: Vec<Host>,
    load_error: Option<String>,
    dialog: Option<Dialog>,
    error: Option<String>,
    search: String,
    target: widget::Id,
}

impl Panel {
    pub fn new(path: Option<PathBuf>) -> Self {
        let (hosts, load_error) = match path.as_deref().map(read_hosts) {
            Some(Ok(hosts)) => (hosts, None),
            Some(Err(error)) => (Vec::new(), Some(error)),
            None => (Vec::new(), Some("找不到 Windows 用户配置目录。".to_owned())),
        };
        Self {
            path,
            hosts,
            load_error,
            dialog: None,
            error: None,
            search: String::new(),
            target: widget::Id::unique(),
        }
    }

    pub fn dialog_open(&self) -> bool {
        self.dialog.is_some()
    }

    pub fn dismiss(&mut self) {
        self.dialog = None;
        self.error = None;
    }

    pub fn update(&mut self, action: Action, home: Option<&Path>) -> Task<Action> {
        match action {
            Action::Add if self.load_error.is_none() => return self.edit(None),
            Action::Edit(index) if self.load_error.is_none() && index < self.hosts.len() => {
                return self.edit(Some(index));
            }
            Action::Search(query) => self.search = query,
            Action::Name(value) => {
                if let Some(Dialog::Edit { name, .. }) = self.dialog.as_mut() {
                    *name = value;
                    self.error = None;
                }
            }
            Action::Target(value) => {
                if let Some(Dialog::Edit { target, .. }) = self.dialog.as_mut() {
                    *target = value;
                    self.error = None;
                }
            }
            Action::Confirm => {
                if let Err(error) = self.save_dialog() {
                    self.error = Some(error);
                }
            }
            Action::AskDelete(index) if index < self.hosts.len() => {
                self.dialog = Some(Dialog::Delete(index));
                self.error = None;
            }
            Action::Import if self.load_error.is_none() => {
                let request = Uuid::new_v4();
                self.dialog = Some(Dialog::Reading(request));
                self.error = None;
                let home = home.map(Path::to_owned);
                return Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || {
                            let home = home.ok_or("找不到 Windows 用户目录。")?;
                            ssh_config::aliases(&home)
                        })
                        .await
                        .map_err(|error| error.to_string())
                        .and_then(|result| result)
                    },
                    move |result| Action::Imported(request, result),
                );
            }
            Action::Imported(request, result) if matches!(self.dialog, Some(Dialog::Reading(open)) if open == request) =>
            {
                let candidates = result.map(|aliases| {
                    self.new_aliases(aliases)
                        .into_iter()
                        .map(|host| (host, false))
                        .collect()
                });
                self.dialog = Some(Dialog::Import(candidates.unwrap_or_else(|error| {
                    self.error = Some(error);
                    Vec::new()
                })));
            }
            Action::SelectAlias(index, selected) => {
                if let Some(Dialog::Import(candidates)) = self.dialog.as_mut()
                    && let Some((_, checked)) = candidates.get_mut(index)
                {
                    *checked = selected;
                }
            }
            Action::Dismiss => self.dismiss(),
            _ => {}
        }
        Task::none()
    }

    fn edit(&mut self, index: Option<usize>) -> Task<Action> {
        let (name, target) = index.map(|index| (&self.hosts[index]).clone()).map_or_else(
            || (String::new(), String::new()),
            |host| (host.name, host.target),
        );
        self.dialog = Some(Dialog::Edit {
            index,
            name,
            target,
        });
        self.error = None;
        widget::operation::focus(self.target.clone())
    }

    fn new_aliases(&self, aliases: Vec<String>) -> Vec<Host> {
        aliases
            .into_iter()
            .filter(|alias| {
                !self
                    .hosts
                    .iter()
                    .any(|host| host.target.eq_ignore_ascii_case(alias))
            })
            .filter_map(|alias| Host::new("", &alias).ok())
            .collect()
    }

    fn save_dialog(&mut self) -> Result<(), String> {
        let mut hosts = self.hosts.clone();
        match &self.dialog {
            Some(Dialog::Edit {
                index,
                name,
                target,
            }) => {
                let host = Host::new(name, target)?;
                if let Some(index) = index {
                    hosts[*index] = host;
                } else {
                    hosts.push(host);
                }
            }
            Some(Dialog::Delete(index)) => {
                hosts.remove(*index);
            }
            Some(Dialog::Import(candidates)) if candidates.iter().any(|(_, checked)| *checked) => {
                hosts.extend(
                    candidates
                        .iter()
                        .filter(|(_, checked)| *checked)
                        .map(|(host, _)| host.clone()),
                );
            }
            _ => return Ok(()),
        }
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let path = self
            .path
            .as_deref()
            .ok_or("找不到 Windows 用户配置目录。")?;
        write_json(path, &hosts).map_err(|error| format!("保存失败：{error}"))?;
        self.hosts = hosts;
        self.search.clear();
        self.dismiss();
        Ok(())
    }

    pub fn sidebar<'a>(
        &'a self,
        recent: &'a [String],
        current: Option<&str>,
    ) -> Element<'a, Action> {
        use theme::WorkspaceIcon;
        let query = self.search.trim().to_lowercase();
        let enabled = self.load_error.is_none();
        let mut entries = column![].spacing(4);
        let mut empty = self.load_error.is_none();
        if let Some(error) = &self.load_error {
            entries = entries.push(
                text(format!("无法读取主机配置：{error}"))
                    .size(13)
                    .color(theme::ERROR),
            );
        }
        for (index, host) in self
            .hosts
            .iter()
            .enumerate()
            .filter(|(_, host)| matches_query(&query, &host.name, &host.target))
        {
            empty = false;
            let target = ssh_destination::label(&host.target);
            let mut title = column![text(&host.name).size(14)];
            if host.name != target {
                title = title.push(text(target).size(12).color(theme::MUTED));
            }
            let connect = button(title.spacing(3))
                .width(Fill)
                .padding([7, 9])
                .on_press(Action::Connect(host.clone()))
                .style(move |_, status| theme::tab(current == Some(host.target.as_str()), status));
            entries = entries.push(
                row![
                    connect,
                    WorkspaceIcon::More.control("编辑或删除主机", Some(Action::Edit(index)), false)
                ]
                .spacing(3)
                .align_y(Center),
            );
        }
        let recent = recent
            .iter()
            .filter(|target| {
                matches_query(&query, target, target)
                    && !self
                        .hosts
                        .iter()
                        .any(|host| host.target.eq_ignore_ascii_case(target))
            })
            .collect::<Vec<_>>();
        if !recent.is_empty() {
            empty = false;
            entries = entries
                .push(container(text("最近连接").size(12).color(theme::MUTED)).padding([5, 8]));
            for target in recent {
                entries = entries.push(nav(
                    ssh_destination::label(target),
                    Action::ConnectRecent(target.clone()),
                    current == Some(target.as_str()),
                ));
            }
        }
        if empty {
            entries = entries.push(
                container(
                    text(if query.is_empty() {
                        "暂无主机"
                    } else {
                        "没有匹配的主机"
                    })
                    .size(13)
                    .color(theme::MUTED),
                )
                .padding([8, 9]),
            );
        }
        column![
            row![
                text("SSH 主机").size(14).font(theme::SEMIBOLD),
                Space::new().width(Fill),
                WorkspaceIcon::Plus.control(
                    "添加主机 (Ctrl+Shift+N)",
                    enabled.then_some(Action::Add),
                    false
                ),
                WorkspaceIcon::Import.control(
                    "导入 SSH 配置",
                    enabled.then_some(Action::Import),
                    false
                ),
            ]
            .spacing(3)
            .align_y(Center),
            text_input("搜索主机", &self.search)
                .on_input(Action::Search)
                .padding([6, 9])
                .size(13),
            scrollable(entries).height(Fill),
        ]
        .spacing(8)
        .height(Fill)
        .into()
    }

    pub fn dialog(&self) -> Option<Element<'_, Action>> {
        let (title, content, confirm, enabled, index) = match self.dialog.as_ref()? {
            Dialog::Edit {
                index,
                name,
                target,
            } => (
                if index.is_some() {
                    "编辑主机"
                } else {
                    "添加主机"
                },
                column![
                    text("显示名称（可选）").size(13).color(theme::MUTED),
                    text_input("例如 开发服务器", name)
                        .padding(9)
                        .on_input(Action::Name)
                        .on_submit(Action::Confirm),
                    text("SSH 目标").size(13).color(theme::MUTED),
                    text_input("SSH 别名或 user@host:port", target)
                        .id(self.target.clone())
                        .padding(9)
                        .on_input(Action::Target)
                        .on_submit(Action::Confirm),
                ]
                .spacing(8)
                .into(),
                "保存",
                ssh_destination::normalize(target).is_some(),
                *index,
            ),
            Dialog::Delete(index) => (
                "删除主机",
                text(format!("删除保存的主机「{}」？", self.hosts[*index].name))
                    .size(14)
                    .into(),
                "删除",
                true,
                None,
            ),
            Dialog::Reading(_) => (
                "导入 SSH 配置",
                text("正在读取本机 SSH 配置…").size(14).into(),
                "导入",
                false,
                None,
            ),
            Dialog::Import(candidates) => {
                let options = if candidates.is_empty() {
                    text("没有新的 SSH 主机别名可导入。")
                        .size(14)
                        .color(theme::MUTED)
                        .into()
                } else {
                    let choices = column(candidates.iter().enumerate().map(
                        |(index, (host, checked))| {
                            checkbox(*checked)
                                .label(&host.target)
                                .on_toggle(move |value| Action::SelectAlias(index, value))
                                .into()
                        },
                    ))
                    .spacing(8);
                    scrollable(choices).height(iced::Length::Shrink).into()
                };
                (
                    "导入 SSH 配置",
                    container(options).max_height(240).into(),
                    "导入",
                    candidates.iter().any(|(_, checked)| *checked),
                    None,
                )
            }
        };
        let mut form = column![text(title).size(19).font(theme::SEMIBOLD), content].spacing(12);
        if let Some(error) = &self.error {
            form = form.push(text(error).size(13).color(theme::ERROR));
        }
        let mut buttons = row![].spacing(8).align_y(Center);
        if let Some(index) = index {
            buttons = buttons.push(
                button(text("删除主机").size(13).color(theme::ERROR))
                    .padding([7, 10])
                    .style(|_, status| theme::tab(false, status))
                    .on_press(Action::AskDelete(index)),
            );
        }
        form = form.push(
            buttons
                .push(Space::new().width(Fill))
                .push(action_button("取消", Some(Action::Dismiss), false))
                .push(action_button(
                    confirm,
                    enabled.then_some(Action::Confirm),
                    true,
                )),
        );
        Some(opaque(
            container(
                container(form)
                    .width(390)
                    .padding(18)
                    .style(|_| theme::panel(theme::PANEL, 12.0)),
            )
            .center(Fill)
            .style(|_| theme::surface(Color::BLACK.scale_alpha(0.48))),
        ))
    }
}

fn matches_query(query: &str, name: &str, target: &str) -> bool {
    query.is_empty() || name.to_lowercase().contains(query) || target.to_lowercase().contains(query)
}

fn nav(label: &str, action: Action, active: bool) -> button::Button<'_, Action> {
    button(text(label).size(14))
        .width(Fill)
        .padding([7, 9])
        .on_press(action)
        .style(move |_, status| theme::tab(active, status))
}

fn action_button(label: &str, action: Option<Action>, primary: bool) -> button::Button<'_, Action> {
    button(text(label).size(14))
        .on_press_maybe(action)
        .padding([7, 14])
        .style(move |_, status| theme::button_status(primary, status))
}

fn read_hosts(path: &Path) -> Result<Vec<Host>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let hosts: Vec<Host> = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    hosts
        .into_iter()
        .map(|host| Host::new(&host.name, &host.target).map_err(str::to_owned))
        .collect()
}

pub fn write_json(path: &Path, data: &impl Serialize) -> std::io::Result<()> {
    std::fs::create_dir_all(path.parent().expect("configuration parent"))?;
    let pending = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let payload = serde_json::to_vec(data)?;
    if let Err(error) =
        std::fs::write(&pending, payload).and_then(|()| std::fs::rename(&pending, path))
    {
        let _ = std::fs::remove_file(pending);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_only_selected_config_aliases() {
        let home = std::env::temp_dir().join(format!("span host profile {}", Uuid::new_v4()));
        let config = home.join(".ssh");
        let include = config.join("team configs");
        std::fs::create_dir_all(&include).unwrap();
        std::fs::write(
            config.join("config"),
            "Host office *.lab !skip
Include \"team configs\\*.conf\"
Host OFFICE
",
        )
        .unwrap();
        std::fs::write(
            include.join("servers.conf"),
            "Host build deploy # optional hosts
HostName fixture.invalid
",
        )
        .unwrap();
        let aliases = ssh_config::aliases(&home).unwrap();
        assert_eq!(aliases, ["office", "build", "deploy"]);
        let path = home.join("hosts.json");
        let mut panel = Panel::new(Some(path.clone()));
        let candidates = panel.new_aliases(aliases);
        panel.dialog = Some(Dialog::Import(
            candidates.into_iter().map(|host| (host, false)).collect(),
        ));
        panel.save_dialog().unwrap();
        assert!(!path.exists());
        let _ = panel.update(Action::SelectAlias(1, true), Some(&home));
        panel.save_dialog().unwrap();
        assert_eq!(
            read_hosts(&path).unwrap(),
            [Host::new("", "build").unwrap()]
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn saves_edits_and_deletes_profiles_across_restarts() {
        let directory = std::env::temp_dir().join(format!("span-hosts-{}", Uuid::new_v4()));
        let path = directory.join("hosts.json");
        let mut panel = Panel::new(Some(path.clone()));
        assert!(panel.hosts.is_empty());
        panel.dialog = Some(Dialog::Edit {
            index: None,
            name: "办公台".into(),
            target: "operator@host:2222".into(),
        });
        panel.save_dialog().unwrap();
        let mut panel = Panel::new(Some(path.clone()));
        assert_eq!(
            panel.hosts,
            [Host::new("办公台", "operator@host:2222").unwrap()]
        );
        panel.dialog = Some(Dialog::Edit {
            index: Some(0),
            name: "工作台".into(),
            target: "alias".into(),
        });
        panel.save_dialog().unwrap();
        let mut panel = Panel::new(Some(path.clone()));
        assert!(panel.new_aliases(vec!["ALIAS".into()]).is_empty());
        assert_eq!(panel.hosts, [Host::new("工作台", "alias").unwrap()]);
        panel.dialog = Some(Dialog::Delete(0));
        panel.save_dialog().unwrap();
        assert!(read_hosts(&path).unwrap().is_empty());
        std::fs::write(&path, b"invalid JSON").unwrap();
        let mut panel = Panel::new(Some(path.clone()));
        assert!(panel.load_error.is_some());
        panel.dialog = Some(Dialog::Edit {
            index: None,
            name: "Test".into(),
            target: "host".into(),
        });
        assert!(panel.save_dialog().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"invalid JSON");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
