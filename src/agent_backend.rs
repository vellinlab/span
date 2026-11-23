/// Backends that implement the Codex App Server protocol. Keep the choice
/// attached to the client so a thread id is never sent to the other backend.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Backend {
    #[default]
    Codex,
    Clue,
}

impl Backend {
    pub const ALL: [Self; 2] = [Self::Codex, Self::Clue];

    pub fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Clue => "Clue",
        }
    }

    #[cfg(windows)]
    pub fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex.exe",
            Self::Clue => "clue.exe",
        }
    }

    pub fn server_script(self) -> String {
        let (program, home) = match self {
            Self::Codex => ("codex", "${CODEX_HOME:-$HOME/.codex}"),
            Self::Clue => ("clue", "${CLUE_HOME:-$HOME/.clue}"),
        };
        format!(
            r#"
if [ -S "{home}/app-server-control/app-server-control.sock" ]; then
    printf "span-codex-shared\n"
    exec {program} app-server proxy
fi
printf "span-codex-stdio\n"
exec {program} app-server
"#
        )
    }
}
