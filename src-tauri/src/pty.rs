use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

use crate::wsl;

/// Minimum column count for a PTY session.
const MIN_COLS: u16 = 20;

/// Minimum row count for a PTY session.
const MIN_ROWS: u16 = 8;

/// Default column count when none is specified.
const DEFAULT_COLS: u16 = 80;

/// Default row count when none is specified.
const DEFAULT_ROWS: u16 = 24;

/// A shell candidate for the fallback chain.
pub struct ShellCandidate {
    pub shell: PathBuf,
    pub args: Vec<String>,
    /// Optional display override used to derive unique profile id and name.
    pub display_name: Option<String>,
}

/// Derive a slug-style id from a display name.
///
/// `"WSL (Ubuntu)"` → `"wsl-ubuntu"`, `"PowerShell"` → `"powershell"`.
/// Non-alphanumeric runs become a single `-`; leading/trailing dashes are stripped.
pub fn display_name_to_id(name: &str) -> String {
    use regex::Regex;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[^a-z0-9]+").expect("static regex is valid"));
    re.replace_all(&name.to_lowercase(), "-")
        .trim_matches('-')
        .to_string()
}

/// Payload emitted on `vibe99:terminal-data`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDataPayload {
    pane_id: String,
    data: String,
}

/// Returns the index of the last complete UTF-8 character boundary in
/// `buf`. Bytes after this point form an incomplete multi-byte sequence
/// and should be carried over to the next read. Returns `buf.len()` when
/// the buffer already ends on a complete boundary.
fn utf8_safe_cut(buf: &[u8]) -> usize {
    let len = buf.len();
    if len == 0 {
        return 0;
    }

    // Walk backwards past continuation bytes (10xxxxxx) to find the leading byte.
    let mut i = len - 1;
    while i > 0 && buf[i] & 0xC0 == 0x80 {
        i -= 1;
    }

    let expected: usize = match buf[i] {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => return len, // invalid leading byte – flush as-is
    };

    let actual = len - i;
    if actual >= expected {
        len
    } else {
        i
    }
}

/// Payload emitted on `vibe99:terminal-exit`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    pane_id: String,
    exit_code: u32,
}

/// Pause flag + condvar shared with the reader thread. While paused the
/// reader parks instead of draining the PTY; the kernel buffer fills up and
/// the child blocks on write — end-to-end flow control driven by the
/// frontend's xterm write-buffer watermarks.
type PauseGate = Arc<(Mutex<bool>, Condvar)>;

/// Clear the pause flag and wake the reader thread. Called whenever a
/// session ends so a parked reader can observe EOF and exit.
fn release_pause_gate(gate: &PauseGate) {
    let (lock, cvar) = &**gate;
    if let Ok(mut paused) = lock.lock() {
        *paused = false;
        cvar.notify_all();
    }
}

/// Holds the live resources for a single PTY session.
struct PtySession {
    /// The master end of the PTY pair. Kept alive so the child process
    /// has a valid controlling terminal. Dropping this causes the child
    /// to receive SIGHUP.
    master: Box<dyn MasterPty + Send>,
    /// Writer to the PTY master (stdin of the child process).
    writer: Box<dyn Write + Send>,
    /// Killer handle to terminate the child process.
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Join handle for the background reader thread.
    _reader_thread: std::thread::JoinHandle<()>,
    /// Join handle for the exit-watcher thread.
    exit_thread: std::thread::JoinHandle<()>,
    /// Flow-control gate parking the reader thread while the frontend
    /// is saturated.
    pause_gate: PauseGate,
    /// Monotonic id distinguishing this spawn from any later session that
    /// reuses the same pane id (SSH reconnect, shell change). The exit
    /// watcher only removes/announces the session if the generation still
    /// matches, so a lingering old child cannot tear down its replacement.
    generation: u64,
}

/// Manages a collection of PTY sessions keyed by pane ID.
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    next_generation: AtomicU64,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(0),
        }
    }

    // ----------------------------------------------------------------
    // Public API
    // ----------------------------------------------------------------

    /// Spawn a new PTY session for the given `pane_id`.
    ///
    /// Emits `vibe99:terminal-data` events with `{ paneId, data }` for
    /// each chunk of output, and `vibe99:terminal-exit` with
    /// `{ paneId, exitCode }` when the child process exits. On exit the
    /// session is automatically removed from the internal map, matching
    /// the Electron behaviour.
    ///
    /// If a session already exists for `pane_id` it is destroyed first.
    ///
    /// `shell_profile_id` overrides the default shell resolution: only
    /// the matching profile (and auto-detected fallbacks) are tried.
    pub fn spawn(
        self: &Arc<Self>,
        app: AppHandle,
        pane_id: &str,
        cols: Option<u16>,
        rows: Option<u16>,
        cwd: Option<&str>,
        shell_profile_id: Option<&str>,
    ) -> Result<(), String> {
        // Kill any previous session for this pane.
        self.destroy(pane_id);

        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);

        let pty_system = native_pty_system();
        let cwd = resolve_working_directory(cwd);
        let cols = cols.unwrap_or(DEFAULT_COLS).max(MIN_COLS);
        let rows = rows.unwrap_or(DEFAULT_ROWS).max(MIN_ROWS);

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open PTY: {e}"))?;

        // Build the shell command with fallback chain.
        let mut cmd = None;
        let mut last_error = String::new();

        for candidate in shell_candidates(&app, shell_profile_id) {
            match build_command(&candidate, &cwd) {
                Ok(c) => {
                    cmd = Some(c);
                    break;
                }
                Err(e) => {
                    last_error = e;
                }
            }
        }

        let mut cmd = cmd.ok_or_else(|| {
            if last_error.is_empty() {
                "No executable shell found".into()
            } else {
                last_error
            }
        })?;

        // Ensure colour support environment variables are set.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "vibe99");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn shell: {e}"))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone PTY reader: {e}"))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to get PTY writer: {e}"))?;

        let master = pair.master;

        // Clone a killer handle before moving the child into the exit task.
        let killer = child.clone_killer();

        let pane_id_owned = pane_id.to_string();

        // Read PTY output on a blocking thread and emit Tauri events.
        // Coalescing: when a read fills the full buffer there is likely more
        // data immediately available, so we accumulate before emitting. We
        // flush when a short read arrives (caught up) or the batch grows past
        // 64 KB, keeping event rate low during high-throughput output.
        let app_reader = app.clone();
        let pane_id_reader = pane_id_owned.clone();
        let pause_gate: PauseGate = Arc::new((Mutex::new(false), Condvar::new()));
        let reader_gate = Arc::clone(&pause_gate);
        let _reader_thread = std::thread::spawn(move || {
            const BUF_SIZE: usize = 8192;
            const BATCH_LIMIT: usize = 65536;
            let mut buf = [0u8; BUF_SIZE];
            // Holds incomplete UTF-8 tail bytes from a previous read so
            // that multi-byte characters are not split across payloads.
            let mut pending: Vec<u8> = Vec::with_capacity(4);

            let emit = |pending: &mut Vec<u8>| {
                let cut = utf8_safe_cut(pending);
                if cut == 0 { return; }
                let text = String::from_utf8_lossy(&pending[..cut]);
                let _ = app_reader.emit(
                    "vibe99:terminal-data",
                    TerminalDataPayload {
                        pane_id: pane_id_reader.clone(),
                        data: text.into_owned(),
                    },
                );
                pending.drain(..cut);
            };

            loop {
                // Flow control: park while the frontend's xterm write buffer
                // is saturated. The session-ending paths call
                // release_pause_gate() so a parked reader always wakes up.
                {
                    let (lock, cvar) = &*reader_gate;
                    let Ok(mut paused) = lock.lock() else { return };
                    while *paused {
                        let Ok(next) = cvar.wait(paused) else { return };
                        paused = next;
                    }
                }
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        // Flush any remaining bytes before closing.
                        if !pending.is_empty() {
                            emit(&mut pending);
                        }
                        break;
                    }
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        // Only emit when we caught up (short read) or hit the
                        // batch size limit. A full-buffer read means more data
                        // is likely waiting, so continue accumulating.
                        if n < BUF_SIZE || pending.len() >= BATCH_LIMIT {
                            emit(&mut pending);
                        }
                    }
                }
            }
        });

        // Watch for child exit on a blocking thread. Emit the exit event
        // and remove the session from the map, matching Electron behaviour.
        let manager = Arc::clone(self);
        let exit_gate = Arc::clone(&pause_gate);
        let exit_thread = std::thread::spawn(move || {
            let exit_code = child.wait().map(|s| s.exit_code()).unwrap_or(1);

            // Remove the session only while it is still THIS spawn's session.
            // spawn() may have already replaced it under the same pane id
            // (SSH reconnect, shell change): removing blindly would delete
            // the live replacement, and emitting an exit event for it would
            // make the frontend close a live pane.
            let should_emit = match manager.sessions.lock() {
                Ok(mut sessions) => match sessions.get(&pane_id_owned) {
                    Some(s) if s.generation == generation => {
                        sessions.remove(&pane_id_owned);
                        true
                    }
                    // A newer session owns this pane id — stay silent.
                    Some(_) => false,
                    // Already removed by destroy(): emit so frontend flows
                    // that wait for the exit message (shell change) still
                    // observe it; a closed pane simply ignores the event.
                    None => true,
                },
                Err(_) => false,
            };

            if should_emit {
                let _ = app.emit(
                    "vibe99:terminal-exit",
                    TerminalExitPayload {
                        pane_id: pane_id_owned.clone(),
                        exit_code,
                    },
                );
            }

            // Wake a parked reader so it can observe EOF and exit (covers
            // natural exit; the destroy paths also release at kill time).
            release_pause_gate(&exit_gate);
        });

        let session = PtySession {
            master,
            writer,
            killer,
            _reader_thread,
            exit_thread,
            pause_gate,
            generation,
        };

        self.sessions
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?
            .insert(pane_id.to_string(), session);

        Ok(())
    }

    /// Write raw bytes to the PTY master for the given `pane_id`.
    pub fn write(&self, pane_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;

        let session = sessions
            .get_mut(pane_id)
            .ok_or_else(|| format!("no session for pane {pane_id}"))?;

        session
            .writer
            .write_all(data)
            .map_err(|e| format!("write to PTY failed: {e}"))?;

        session
            .writer
            .flush()
            .map_err(|e| format!("flush PTY failed: {e}"))?;

        Ok(())
    }

    /// Resize the PTY for the given `pane_id`. Column and row values are
    /// clamped to the configured minimums.
    pub fn resize(&self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;

        let session = sessions
            .get(pane_id)
            .ok_or_else(|| format!("no session for pane {pane_id}"))?;

        session
            .master
            .resize(PtySize {
                rows: rows.max(MIN_ROWS),
                cols: cols.max(MIN_COLS),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))?;

        Ok(())
    }

    /// Pause or resume PTY output reading for `pane_id` (frontend flow
    /// control). Unknown pane ids are ignored: a resume can race with
    /// session teardown.
    pub fn set_paused(&self, pane_id: &str, paused: bool) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("lock poisoned: {e}"))?;
        if let Some(session) = sessions.get(pane_id) {
            let (lock, cvar) = &*session.pause_gate;
            *lock.lock().map_err(|e| format!("pause lock poisoned: {e}"))? = paused;
            cvar.notify_all();
        }
        Ok(())
    }

    /// Kill the child process and remove the session for `pane_id`.
    /// The exit-watcher thread is joined in the background so the IPC caller
    /// never blocks — even if the child takes time to notice the signal.
    pub fn destroy(&self, pane_id: &str) {
        let exit_handle = {
            let mut sessions = match self.sessions.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            let Some(session) = sessions.remove(pane_id) else {
                return;
            };
            let PtySession { mut killer, exit_thread, pause_gate, .. } = session;
            // Wake a parked reader BEFORE killing: a paused child may be
            // blocked writing to the full PTY buffer, and if its signal
            // handler needs a final tty write to finish exiting, the kill
            // alone never completes and the exit watcher (the other unpause
            // point) never runs — a circular wait.
            release_pause_gate(&pause_gate);
            let _ = killer.kill();
            exit_thread
        };
        std::thread::spawn(move || { let _ = exit_handle.join(); });
    }

    /// Destroy all active sessions.
    pub fn destroy_all(&self) {
        let exit_handles: Vec<_> = self.sessions.lock()
            .map(|mut sessions| {
                sessions.drain()
                    .map(|(_, mut session)| {
                        // Same unpause-before-kill as destroy(): this join
                        // loop runs on the main thread during shutdown and
                        // must never wait on a write-blocked paused child.
                        release_pause_gate(&session.pause_gate);
                        let _ = session.killer.kill();
                        session.exit_thread
                    })
                    .collect()
            })
            .unwrap_or_default();
        for handle in exit_handles {
            let _ = handle.join();
        }
    }
}

// ----------------------------------------------------------------
// Shell resolution
// ----------------------------------------------------------------

/// Return the ordered list of shell candidates for spawning a PTY.
///
/// Priority:
/// 1. Default profile from settings (if configured and valid).
/// 2. Remaining profiles from settings (if any).
/// 3. Auto-detected platform fallbacks including WSL (always appended as safety net).
///
/// When `shell_profile_id` is `Some(id)`, only the matching profile is
/// tried (with auto-detected fallbacks as safety net), bypassing the
/// normal priority order.
fn shell_candidates(app: &AppHandle, shell_profile_id: Option<&str>) -> Vec<ShellCandidate> {
    let mut candidates: Vec<ShellCandidate> = Vec::new();
    let mut seen: HashSet<(PathBuf, Option<String>)> = HashSet::new();

    if let Ok(config) = load_settings_config(app) {
        let profiles = extract_profiles(&config);
        let default_id = extract_default_profile(&config);

        // If a specific profile is requested, use only that one.
        if let Some(requested_id) = shell_profile_id {
            if let Some(profile) = profiles.iter().find(|p| p.id == requested_id) {
                let path = PathBuf::from(&profile.command);
                if seen.insert((path.clone(), None)) {
                    candidates.push(ShellCandidate {
                        shell: path,
                        args: profile.args.clone(),
                        display_name: None,
                    });
                }
            }
        } else {
            // Normal priority: default profile first, then the rest.
            let ordered: Vec<_> = profiles
                .iter()
                .filter(|p| p.id != default_id)
                .chain(profiles.iter().filter(|p| p.id == default_id))
                .collect();

            for profile in ordered.into_iter().rev() {
                let path = PathBuf::from(&profile.command);
                if seen.insert((path.clone(), None)) {
                    candidates.push(ShellCandidate {
                        shell: path,
                        args: profile.args.clone(),
                        display_name: None,
                    });
                }
            }
        }
    }

    // Auto-detected fallbacks.
    let detected = auto_detected_candidates();

    // If a specific profile was requested but not found in settings,
    // try to match it against auto-detected candidates by id.
    if let Some(requested_id) = shell_profile_id {
        if candidates.is_empty() {
            let requested_lower = requested_id.to_lowercase();
            for candidate in &detected {
                // Match by display_name-derived id first, then by shell stem.
                let derived_id = candidate
                    .display_name
                    .as_ref()
                    .map(|d| display_name_to_id(d));
                let matches_display = derived_id.as_deref() == Some(&requested_lower);
                let stem = candidate
                    .shell
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default()
                    .to_lowercase();
                if matches_display || stem == requested_lower {
                    if seen.insert((candidate.shell.clone(), candidate.display_name.clone())) {
                        candidates.push(ShellCandidate {
                            shell: candidate.shell.clone(),
                            args: candidate.args.clone(),
                            display_name: candidate.display_name.clone(),
                        });
                    }
                    break;
                }
            }
        }
    }

    // Append remaining auto-detected fallbacks (deduplicated).
    for candidate in detected {
        if seen.insert((candidate.shell.clone(), candidate.display_name.clone())) {
            candidates.push(candidate);
        }
    }

    candidates
}

/// Load and sanitize settings from disk.
fn load_settings_config(app: &AppHandle) -> Result<serde_json::Value, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?
        .join("settings.json");

    if !path.exists() {
        return Err("no settings file".into());
    }

    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("failed to read settings: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&contents).unwrap_or(serde_json::Value::Null);

    // Reuse the same sanitization as the settings command layer.
    Ok(crate::commands::settings::sanitize_config(&parsed))
}

/// Extract shell profiles from a sanitized config value.
fn extract_profiles(config: &serde_json::Value) -> Vec<crate::commands::settings::ShellProfile> {
    config
        .get("shell")
        .and_then(|s| s.get("profiles"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

/// Extract the default profile id from a sanitized config value.
fn extract_default_profile(config: &serde_json::Value) -> String {
    config
        .get("shell")
        .and_then(|s| s.get("defaultProfile"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

// ----------------------------------------------------------------
// Auto-detection fallback
// ----------------------------------------------------------------

/// Return platform-specific shell candidates via environment inspection.
///
/// This is the fallback chain used when no profiles are configured in
/// settings, or when all configured profiles fail to resolve.
/// On Windows, WSL shells are offered after native Windows shells.
pub fn auto_detected_candidates() -> Vec<ShellCandidate> {
    let mut candidates: Vec<ShellCandidate> = Vec::new();

    if cfg!(target_os = "windows") {
        // Windows: check custom env, then PowerShell, then pwsh, then
        // ComSpec, then cmd.exe, then WSL (if available).
        if let Ok(custom) = std::env::var("VIBE99_WINDOWS_SHELL") {
            if !custom.is_empty() {
                // Special case: "wsl.exe" triggers WSL detection.
                if custom.eq_ignore_ascii_case("wsl.exe") {
                    push_wsl_candidates(&mut candidates, None);
                } else {
                    candidates.push(ShellCandidate {
                        shell: PathBuf::from(&custom),
                        args: vec![],
                        display_name: None,
                    });
                }
            }
        }
        for shell in &["powershell.exe", "pwsh.exe", "cmd.exe"] {
            candidates.push(ShellCandidate {
                shell: PathBuf::from(shell),
                args: vec![],
                display_name: None,
            });
        }
        if let Ok(comspec) = std::env::var("ComSpec") {
            if !comspec.is_empty() {
                candidates.push(ShellCandidate {
                    shell: PathBuf::from(&comspec),
                    args: vec![],
                    display_name: None,
                });
            }
        }
        // Append WSL candidates after native Windows shells.
        push_wsl_candidates(&mut candidates, None);
    } else {
        // Unix (Linux / macOS): $SHELL first (only if absolute), then
        // platform-specific fallbacks, deduplicated.
        let mut seen = HashSet::new();

        if let Ok(shell) = std::env::var("SHELL") {
            let p = PathBuf::from(&shell);
            if p.is_absolute() && seen.insert(p.clone()) {
                candidates.push(ShellCandidate {
                    shell: p,
                    args: vec!["-il".into()],
                    display_name: None,
                });
            }
        }

        let fallbacks: &[&str] = if cfg!(target_os = "macos") {
            &["/bin/zsh", "/bin/bash", "/bin/sh"]
        } else {
            &["/bin/bash", "/bin/sh"]
        };

        for shell in fallbacks {
            let p = PathBuf::from(shell);
            if seen.insert(p.clone()) && is_executable(&p) {
                candidates.push(ShellCandidate {
                    shell: p,
                    args: vec!["-il".into()],
                    display_name: None,
                });
            }
        }
    }

    candidates
}

/// Append WSL shell candidates to the list — one per detected distribution.
///
/// On non-Windows or when WSL is not available this is a no-op.
/// `distro_override` allows forcing a specific distribution (used by
/// `VIBE99_WINDOWS_SHELL=wsl.exe`).
#[cfg(target_os = "windows")]
fn push_wsl_candidates(candidates: &mut Vec<ShellCandidate>, distro_override: Option<&str>) {
    if !wsl::is_wsl_available() {
        return;
    }

    let default_shell = wsl::detect_wsl_default_shell().unwrap_or_else(|| "/bin/bash".into());

    if let Some(distro) = distro_override {
        let args = wsl::wsl_shell_args(Some(distro), &default_shell, &["-il".into()]);
        candidates.push(ShellCandidate {
            shell: PathBuf::from("wsl.exe"),
            args,
            display_name: Some(format!("WSL ({})", distro)),
        });
        return;
    }

    let distros = wsl::list_distributions();
    for distro in &distros {
        let args = wsl::wsl_shell_args(Some(distro), &default_shell, &["-il".into()]);
        candidates.push(ShellCandidate {
            shell: PathBuf::from("wsl.exe"),
            args,
            display_name: Some(format!("WSL ({})", distro)),
        });
    }
}

#[cfg(not(target_os = "windows"))]
fn push_wsl_candidates(_candidates: &mut Vec<ShellCandidate>, _distro_override: Option<&str>) {}

/// Build a `CommandBuilder` for a shell candidate. Returns an error if
/// the candidate binary does not exist or is not executable.
///
/// WSL candidates (shell == "wsl.exe") are handled specially: `wsl.exe`
/// is verified on the Windows side, but the inner shell (e.g. `/bin/bash`)
/// is not checked since it lives inside the WSL filesystem. The `cwd` is
/// converted from Windows to WSL path format when the candidate is WSL.
fn build_command(candidate: &ShellCandidate, cwd: &Path) -> Result<CommandBuilder, String> {
    let is_wsl = cfg!(target_os = "windows")
        && candidate
            .shell
            .file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("wsl.exe"));

    if is_wsl {
        // Verify wsl.exe exists on the Windows PATH.
        let wsl_path = which("wsl.exe").ok_or("wsl.exe not found on PATH")?;

        let mut cmd = CommandBuilder::new(&wsl_path);
        cmd.args(&candidate.args);

        // Convert Windows cwd to WSL path if it looks like a Windows path.
        let cwd_str = cwd.to_string_lossy();
        if let Some(wsl_cwd) = wsl::windows_to_wsl_path(&cwd_str) {
            cmd.cwd(PathBuf::from(&wsl_cwd));
        } else {
            cmd.cwd(cwd);
        }

        // Set WSLENV so WSL forwards selected env vars from Windows.
        let wslenv = wsl::wslenv_value();
        cmd.env("WSLENV", wslenv);

        return Ok(cmd);
    }

    // Resolve bare names (e.g. "powershell.exe") via PATH lookup.
    let shell_path = if candidate.shell.is_absolute() {
        if !candidate.shell.exists() {
            return Err(format!("shell not found: {:?}", candidate.shell));
        }
        candidate.shell.clone()
    } else {
        which(&candidate.shell.to_string_lossy())
            .ok_or_else(|| format!("shell not found on PATH: {:?}", candidate.shell))?
    };

    if !is_executable(&shell_path) {
        return Err(format!("shell not executable: {:?}", shell_path));
    }

    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.args(&candidate.args);
    cmd.cwd(cwd);
    Ok(cmd)
}

// ----------------------------------------------------------------
// Working directory resolution
// ----------------------------------------------------------------

/// Resolve the working directory for a new PTY session.
///
/// 1. Use the provided `cwd` if it is a valid directory.
/// 2. Fall back to `$HOME` (preferred over process cwd on macOS app bundles
///    which start at `/`).
/// 3. Fall back to the process working directory.
fn resolve_working_directory(cwd: Option<&str>) -> PathBuf {
    if let Some(cwd) = cwd {
        let p = PathBuf::from(cwd);
        if p.is_dir() {
            return std::fs::canonicalize(&p).unwrap_or(p);
        }
    }

    // Prefer HOME over process cwd; on macOS the app bundle starts at '/'.
    if let Some(home) = dirs_home() {
        if home.is_dir() {
            return home;
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

/// Return the user's home directory.
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/// Locate an executable on the system PATH.
///
/// Returns the full path if found, `None` otherwise. On Windows this also
/// checks the current directory and appends `.exe` if no extension is
/// present.
#[cfg(target_os = "windows")]
fn which(name: &str) -> Option<PathBuf> {
    // Check the bare name first (handles absolute paths).
    if Path::new(name).is_file() {
        return Some(PathBuf::from(name));
    }

    let exe_name = if name.ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };

    // System PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(';') {
            let candidate = PathBuf::from(dir).join(&exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

#[cfg(not(target_os = "windows"))]
fn which(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.is_absolute() {
        return if p.is_file() { Some(p.to_path_buf()) } else { None };
    }
    std::env::var_os("PATH").and_then(|path_os| {
        std::env::split_paths(&path_os).map(|dir| dir.join(name)).find(|p| p.is_file())
    })
}

/// Check whether a path refers to an executable file.
#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── utf8_safe_cut ─────────────────────────────────────────────────────

    #[test]
    fn utf8_safe_cut_empty_buffer() {
        assert_eq!(utf8_safe_cut(&[]), 0);
    }

    #[test]
    fn utf8_safe_cut_all_ascii_returns_length() {
        let buf = b"hello world";
        assert_eq!(utf8_safe_cut(buf), buf.len());
    }

    #[test]
    fn utf8_safe_cut_complete_two_byte_char() {
        let s = "héllo"; // é = 2 bytes (0xC3 0xA9)
        let buf = s.as_bytes();
        assert_eq!(utf8_safe_cut(buf), buf.len());
    }

    #[test]
    fn utf8_safe_cut_incomplete_two_byte_char() {
        // 'h' (0x68) + first byte of 'é' (0xC3) — incomplete
        let buf: &[u8] = &[0x68, 0xC3];
        assert_eq!(utf8_safe_cut(buf), 1); // only 'h' is safe
    }

    #[test]
    fn utf8_safe_cut_complete_three_byte_char() {
        let s = "日"; // 3 bytes: E6 97 A5
        let buf = s.as_bytes();
        assert_eq!(utf8_safe_cut(buf), 3);
    }

    #[test]
    fn utf8_safe_cut_incomplete_three_byte_char() {
        let s = "日";
        let buf = s.as_bytes();
        assert_eq!(utf8_safe_cut(&buf[..2]), 0); // both bytes are part of the sequence
    }

    #[test]
    fn utf8_safe_cut_complete_four_byte_char() {
        let s = "𝄞"; // 4 bytes: F0 9D 84 9E
        let buf = s.as_bytes();
        assert_eq!(utf8_safe_cut(buf), 4);
    }

    #[test]
    fn utf8_safe_cut_incomplete_four_byte_char() {
        let s = "𝄞";
        let buf = s.as_bytes();
        // 3 bytes of a 4-byte sequence
        assert_eq!(utf8_safe_cut(&buf[..3]), 0);
    }

    #[test]
    fn utf8_safe_cut_mixed_ascii_and_cjk() {
        let s = "hi日本語";
        let buf = s.as_bytes();
        assert_eq!(utf8_safe_cut(buf), buf.len());
    }

    #[test]
    fn utf8_safe_cut_single_ascii_byte() {
        assert_eq!(utf8_safe_cut(b"a"), 1);
    }

    #[test]
    fn utf8_safe_cut_ascii_then_incomplete_multibyte() {
        // "abc" + first byte of 'é'
        let buf: Vec<u8> = b"abc".iter().chain(&[0xC3u8]).copied().collect();
        assert_eq!(utf8_safe_cut(&buf), 3);
    }

    // ── display_name_to_id ────────────────────────────────────────────────

    #[test]
    fn display_name_to_id_basic_lowercase() {
        assert_eq!(display_name_to_id("PowerShell"), "powershell");
    }

    #[test]
    fn display_name_to_id_parens_become_dash() {
        assert_eq!(display_name_to_id("WSL (Ubuntu)"), "wsl-ubuntu");
    }

    #[test]
    fn display_name_to_id_spaces_collapsed_to_dash() {
        assert_eq!(display_name_to_id("My Shell 2"), "my-shell-2");
    }

    #[test]
    fn display_name_to_id_leading_trailing_dashes_stripped() {
        assert_eq!(display_name_to_id("(Ubuntu)"), "ubuntu");
    }

    #[test]
    fn display_name_to_id_runs_of_non_alphanumeric_become_single_dash() {
        assert_eq!(display_name_to_id("a  --  b"), "a-b");
    }

    #[test]
    fn display_name_to_id_already_slug() {
        assert_eq!(display_name_to_id("bash"), "bash");
    }

    #[test]
    fn display_name_to_id_empty_string() {
        assert_eq!(display_name_to_id(""), "");
    }

    #[test]
    fn display_name_to_id_only_special_chars() {
        assert_eq!(display_name_to_id("---"), "");
    }
}
