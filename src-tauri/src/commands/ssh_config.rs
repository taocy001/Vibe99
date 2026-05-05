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
pub fn read_ssh_config() -> Vec<SshHostEntry> {
    let home = match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        Some(h) => PathBuf::from(h),
        None => return vec![],
    };
    let config_path = home.join(".ssh").join("config");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    parse_ssh_config(&content, &home)
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
        let idfile = identity_file.as_deref().map(|f| expand_tilde(f, home));
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
