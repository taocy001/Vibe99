use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostEntry {
    pub alias: String,
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
}

/// Read and parse ~/.ssh/config, returning one entry per non-wildcard Host alias.
#[tauri::command]
pub fn read_ssh_config() -> Result<Vec<SshHostEntry>, String> {
    let home = match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        Some(h) => PathBuf::from(h),
        None => return Ok(vec![]),
    };
    let config_path = home.join(".ssh").join("config");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Failed to read ~/.ssh/config: {e}")),
    };
    Ok(parse_ssh_config(&content, &home))
}

fn expand_tilde(path: &str, home: &Path) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest).to_string_lossy().into_owned()
    } else {
        path.to_string()
    }
}

fn flush_entry(
    aliases: &[String],
    hostname: &Option<String>,
    port: Option<u16>,
    user: &Option<String>,
    identity_file: &Option<String>,
    home: &Path,
    entries: &mut Vec<SshHostEntry>,
) {
    for alias in aliases {
        if alias.contains('*') || alias.contains('?') {
            continue;
        }
        let host = hostname.clone().unwrap_or_else(|| alias.clone());
        // Return only the filename, not the full path, so the IPC response
        // does not leak the user's home directory layout to the renderer.
        let idfile = identity_file.as_deref().map(|f| {
            let expanded = expand_tilde(f, home);
            Path::new(&expanded)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| expanded)
        });
        entries.push(SshHostEntry {
            alias: alias.clone(),
            host,
            port,
            user: user.clone(),
            identity_file: idfile,
        });
    }
}

fn parse_ssh_config(content: &str, home: &Path) -> Vec<SshHostEntry> {
    let mut entries: Vec<SshHostEntry> = Vec::new();
    let mut aliases: Vec<String> = Vec::new();
    let mut hostname: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut user: Option<String> = None;
    let mut identity_file: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (keyword, value) = match line.split_once(|c: char| c.is_whitespace()) {
            Some((k, v)) => (k.to_lowercase(), v.trim()),
            None => continue,
        };
        match keyword.as_str() {
            "host" => {
                flush_entry(&aliases, &hostname, port, &user, &identity_file, home, &mut entries);
                aliases = value.split_whitespace().map(String::from).collect();
                hostname = None;
                port = None;
                user = None;
                identity_file = None;
            }
            "hostname" => { hostname = Some(value.to_string()); }
            "port" => { port = value.parse().ok(); }
            "user" => { user = Some(value.to_string()); }
            "identityfile" => { identity_file = Some(value.to_string()); }
            _ => {}
        }
    }
    flush_entry(&aliases, &hostname, port, &user, &identity_file, home, &mut entries);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn home() -> PathBuf { PathBuf::from("/home/user") }

    #[test]
    fn basic_host_parsed() {
        let content = "Host myserver\n  HostName example.com\n  Port 2222\n  User ubuntu\n";
        let entries = parse_ssh_config(content, &home());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].alias, "myserver");
        assert_eq!(entries[0].host, "example.com");
        assert_eq!(entries[0].port, Some(2222));
        assert_eq!(entries[0].user.as_deref(), Some("ubuntu"));
    }

    #[test]
    fn missing_hostname_falls_back_to_alias() {
        let entries = parse_ssh_config("Host myserver\n", &home());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "myserver");
    }

    #[test]
    fn wildcard_star_host_skipped() {
        let entries = parse_ssh_config("Host *\n  ServerAliveInterval 60\n", &home());
        assert_eq!(entries.len(), 0);
    }

    #[test]
    fn wildcard_question_mark_host_skipped() {
        let entries = parse_ssh_config("Host server?\n  HostName example.com\n", &home());
        assert_eq!(entries.len(), 0);
    }

    #[test]
    fn multiple_hosts_all_parsed() {
        let content = "Host a\n  HostName a.example.com\nHost b\n  HostName b.example.com\n";
        let entries = parse_ssh_config(content, &home());
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].alias, "a");
        assert_eq!(entries[1].alias, "b");
    }

    #[test]
    fn comments_and_blank_lines_ignored() {
        let content = "\n# comment\nHost myserver\n  # inline comment\n  HostName example.com\n";
        let entries = parse_ssh_config(content, &home());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "example.com");
    }

    #[test]
    fn tilde_identity_file_returns_filename_only() {
        let content = "Host myserver\n  IdentityFile ~/.ssh/id_rsa\n";
        let entries = parse_ssh_config(content, &home());
        assert_eq!(entries[0].identity_file.as_deref(), Some("id_rsa"));
    }

    #[test]
    fn absolute_identity_file_returns_filename_only() {
        let content = "Host myserver\n  IdentityFile /home/user/.ssh/mykey\n";
        let entries = parse_ssh_config(content, &home());
        assert_eq!(entries[0].identity_file.as_deref(), Some("mykey"));
    }

    #[test]
    fn empty_config_returns_empty() {
        assert!(parse_ssh_config("", &home()).is_empty());
    }

    #[test]
    fn multiple_aliases_on_one_host_line() {
        let content = "Host alias1 alias2\n  HostName example.com\n";
        let entries = parse_ssh_config(content, &home());
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].alias, "alias1");
        assert_eq!(entries[1].alias, "alias2");
        assert_eq!(entries[0].host, "example.com");
        assert_eq!(entries[1].host, "example.com");
    }

    #[test]
    fn invalid_port_produces_none() {
        let content = "Host myserver\n  Port notanumber\n";
        let entries = parse_ssh_config(content, &home());
        assert!(entries[0].port.is_none());
    }

    #[test]
    fn keywords_are_case_insensitive() {
        let content = "HOST myserver\n  HOSTNAME example.com\n  PORT 22\n";
        let entries = parse_ssh_config(content, &home());
        assert_eq!(entries[0].host, "example.com");
        assert_eq!(entries[0].port, Some(22));
    }

    #[test]
    fn host_without_trailing_newline_parsed() {
        let content = "Host myserver\n  HostName example.com";
        let entries = parse_ssh_config(content, &home());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "example.com");
    }

    #[test]
    fn expand_tilde_replaces_prefix() {
        let home = home();
        assert_eq!(expand_tilde("~/.ssh/id_rsa", &home), "/home/user/.ssh/id_rsa");
    }

    #[test]
    fn expand_tilde_leaves_absolute_path_unchanged() {
        let home = home();
        assert_eq!(expand_tilde("/absolute/path", &home), "/absolute/path");
    }

    #[test]
    fn expand_tilde_leaves_relative_path_unchanged() {
        let home = home();
        assert_eq!(expand_tilde("relative/path", &home), "relative/path");
    }
}
