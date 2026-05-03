use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::pty::PtyManager;

/// Managed state holding the PTY session manager.
pub struct AppState {
    pub pty: Arc<PtyManager>,
}

/// Create a new PTY session for a terminal pane.
///
/// If a session already exists for the given `pane_id` it is destroyed
/// before the new one is spawned.
///
/// PTY output is forwarded to the frontend via the `vibe99:terminal-data` event:
/// ```json
/// { "paneId": "...", "data": "<utf8>" }
/// ```
///
/// When the child process exits, a `vibe99:terminal-exit` event is emitted:
/// ```json
/// { "paneId": "...", "exitCode": 0 }
/// ```
#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
    shell_profile_id: Option<String>,
) -> Result<(), String> {
    state.pty
        .spawn(app, &pane_id, cols, rows, cwd.as_deref(), shell_profile_id.as_deref())
}

/// Write raw bytes to the PTY for the given pane.
///
/// `data` is expected to be a base64-encoded string of the bytes to write.
#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    let bytes = base64_decode(&data).map_err(|e| format!("invalid base64 data: {e}"))?;
    state.pty.write(&pane_id, &bytes)
}

/// Resize the PTY for the given pane.
#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty.resize(&pane_id, cols, rows)
}

/// Destroy the PTY session for the given pane.
#[tauri::command]
pub fn terminal_destroy(state: State<'_, AppState>, pane_id: String) {
    state.pty.destroy(&pane_id);
}

/// Destroy all active PTY sessions.
///
/// Called during application shutdown to ensure child processes are cleaned up.
pub fn destroy_all_terminals(state: &AppState) {
    state.pty.destroy_all();
}

/// Terminate the process immediately after cleaning up PTY sessions.
///
/// More reliable than going through the window-close event chain, which can
/// be silently swallowed by async IPC errors.
#[tauri::command]
pub fn exit_app(state: State<'_, AppState>) {
    destroy_all_terminals(&state);
    std::process::exit(0);
}

/// Return username and hostname for window title format variables (\u, \h, \H).
#[tauri::command]
pub fn get_system_info() -> SystemInfo {
    SystemInfo {
        username: std::env::var("USER").unwrap_or_default(),
        hostname: get_hostname(),
    }
}

#[derive(serde::Serialize)]
pub struct SystemInfo {
    pub username: String,
    pub hostname: String,
}

fn get_hostname() -> String {
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() { return h; }
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Return the current working directory as a string.
///
/// Used by the frontend to derive the default tab title (directory basename).
#[tauri::command]
pub fn get_cwd() -> Result<String, String> {
    // On macOS the app bundle process starts at '/'; prefer $HOME as the
    // sensible default cwd for new terminals.  Validate the path before
    // returning it so the JS side always receives a real directory.
    if let Ok(home) = std::env::var("HOME") {
        if std::path::Path::new(&home).is_dir() {
            return Ok(home);
        }
    }
    std::env::current_dir()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("failed to get cwd: {e}"))
}

// ----------------------------------------------------------------
// Base64 helpers
// ----------------------------------------------------------------

fn base64_decode(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("{e}"))
}
