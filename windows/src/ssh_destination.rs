use std::fmt::Write;
use std::net::Ipv6Addr;

// Return one OpenSSH destination argument, usable by the terminal, Codex and SFTP.
pub fn normalize(value: &str) -> Option<String> {
    let value = value.trim();
    let uri = value.strip_prefix("ssh://");
    let authority = match uri {
        Some(authority) => authority.strip_suffix('/').unwrap_or(authority),
        None => value,
    };
    if authority.is_empty()
        || authority.starts_with('-')
        || authority.contains(['/', '"', '\'', '`'])
        || authority
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return None;
    }

    let login = if uri.is_some() {
        authority.split_once('@')
    } else {
        authority.rsplit_once('@')
    };
    let address = if let Some((user, address)) = login {
        if user.is_empty() || user.contains(':') {
            return None;
        }
        address
    } else {
        authority
    };

    let Endpoint { host, ipv6, port } = endpoint(address, uri.is_none())?;
    if uri.is_none() && !address.starts_with('[') && port.is_none() {
        return Some(value.into());
    }

    let mut destination = String::from("ssh://");
    if let Some((user, _)) = login {
        if uri.is_some() {
            destination.push_str(user);
        } else {
            for byte in user.bytes() {
                if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                    destination.push(char::from(byte));
                } else {
                    write!(&mut destination, "%{byte:02X}").expect("write to String");
                }
            }
        }
        destination.push('@');
    }
    if ipv6 {
        write!(&mut destination, "[{host}]").expect("write to String");
    } else {
        destination.push_str(host);
    }
    if let Some(port) = port {
        write!(&mut destination, ":{port}").expect("write to String");
    }
    Some(destination)
}

pub fn label(destination: &str) -> &str {
    destination.strip_prefix("ssh://").unwrap_or(destination)
}

struct Endpoint<'a> {
    host: &'a str,
    ipv6: bool,
    port: Option<u16>,
}

fn endpoint(address: &str, plain: bool) -> Option<Endpoint<'_>> {
    if let Some(address) = address.strip_prefix('[') {
        let (host, suffix) = address.split_once(']')?;
        if !is_ipv6(host) {
            return None;
        }
        let port = if suffix.is_empty() {
            None
        } else {
            Some(parse_port(suffix.strip_prefix(':')?)?)
        };
        return Some(Endpoint {
            host,
            ipv6: true,
            port,
        });
    }
    if is_ipv6(address) {
        return Some(Endpoint {
            host: address,
            ipv6: true,
            port: None,
        });
    }
    let (host, port) = match address.split_once(':') {
        Some((host, port)) => (host, Some(parse_port(port)?)),
        None => (address, None),
    };
    // OpenSSH aliases without a URI can contain characters unavailable in URI hostnames.
    let alias = plain && port.is_none();
    (!host.is_empty()
        && !host.starts_with('-')
        && host.chars().all(|ch| {
            ch.is_alphanumeric() || ".-_".contains(ch) || (alias && "+~!=#%".contains(ch))
        }))
    .then_some(Endpoint {
        host,
        ipv6: false,
        port,
    })
}

fn parse_port(value: &str) -> Option<u16> {
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok().filter(|port| *port > 0)
}

fn is_ipv6(address: &str) -> bool {
    let address = if let Some((address, scope)) = address.split_once('%') {
        if scope.is_empty()
            || !scope
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._".contains(&byte))
        {
            return false;
        }
        address
    } else {
        address
    };
    address.parse::<Ipv6Addr>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_ssh_aliases_ports_and_ipv6() {
        for (input, expected) in [
            (" office ", "office"),
            ("office+dev", "office+dev"),
            ("dev@office", "dev@office"),
            ("dev@office:02222", "ssh://dev@office:2222"),
            ("[::1]:2222", "ssh://[::1]:2222"),
            ("[::1]", "ssh://[::1]"),
            ("::1", "::1"),
            ("ssh://[fe80::1%7]/", "ssh://[fe80::1%7]"),
            ("domain\\dev@office:2222", "ssh://domain%5Cdev@office:2222"),
            ("dev@domain@office:2222", "ssh://dev%40domain@office:2222"),
        ] {
            assert_eq!(normalize(input).as_deref(), Some(expected));
            assert_eq!(normalize(expected).as_deref(), Some(expected));
        }
    }

    #[test]
    fn rejects_invalid_destinations() {
        for address in [
            "",
            "-oProxyCommand",
            "example other",
            "user@-host",
            "user@",
            "@host",
            "host:0",
            "host:65536",
            "[::1]:",
            "[localhost]",
            "https://host",
            "ssh://host/a-path",
            "ssh://user:password@host",
        ] {
            assert!(normalize(address).is_none(), "accepted {address:?}");
        }
    }

    #[test]
    fn windows_openssh_resolves_the_same_destination_for_all_connection_types() {
        use std::process::Command;

        let config = std::env::temp_dir().join(format!("span-ssh-{}.conf", uuid::Uuid::new_v4()));
        std::fs::write(
            &config,
            "Host fixture fixture+lab\n  HostName 127.0.0.1\n  User span-ci\n  Port 21000\n",
        )
        .unwrap();
        let resolve = |destination: &str, options: &[&str], extra: &[&str]| {
            Command::new(crate::ssh::PROGRAM)
                .arg("-G")
                .arg("-F")
                .arg(&config)
                .args(options)
                .args(["--", destination])
                .args(extra)
                .output()
        };
        let destination = normalize("span-ci@fixture:2222").unwrap();
        let sftp = [crate::ssh::BACKGROUND, &["-s"]].concat();
        let results = [
            (resolve("fixture", &["-tt"], &[]), 21000),
            (
                resolve(&normalize("fixture+lab").unwrap(), &["-tt"], &[]),
                21000,
            ),
            (resolve(&destination, &["-tt"], &[]), 2222),
            (resolve(&destination, &sftp, &["sftp"]), 2222),
            (
                resolve(&destination, crate::ssh::BACKGROUND, &["codex app-server"]),
                2222,
            ),
        ];
        std::fs::remove_file(config).unwrap();
        for (result, port) in results {
            let result = result.expect("Windows OpenSSH client");
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            let settings = String::from_utf8_lossy(&result.stdout);
            for expected in [
                "hostname 127.0.0.1",
                "user span-ci",
                &format!("port {port}"),
            ] {
                assert!(
                    settings.lines().any(|line| line == expected),
                    "missing {expected}"
                );
            }
        }
    }
}
