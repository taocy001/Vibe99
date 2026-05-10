use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

static SETTINGS_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
pub(crate) fn acquire_settings_lock() -> std::sync::MutexGuard<'static, ()> {
    SETTINGS_WRITE_LOCK.get_or_init(|| Mutex::new(()))
        .lock().unwrap_or_else(|e| e.into_inner())
}

const CURRENT_CONFIG_VERSION: u8 = 5;

const DEFAULT_FONT_SIZE: u32 = 13;
const DEFAULT_PANE_OPACITY: f64 = 0.8;
const DEFAULT_PANE_WIDTH: u32 = 720;

// ----------------------------------------------------------------
// Shell profile types
// ----------------------------------------------------------------

/// SSH connection parameters stored alongside an SSH shell profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
}

fn is_kind_local(k: &String) -> bool { k == "local" }
fn default_kind() -> String { "local".to_string() }

/// A named shell configuration that users can select as their default
/// terminal shell. The profile is a pure data record — all behavior
/// (spawning, argument handling) is derived from these fields by the
/// PTY layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    /// Unique identifier (e.g. "bash", "zsh", "pwsh"). Must be non-empty.
    pub id: String,
    /// Human-readable label shown in the UI. Falls back to `id` if empty.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// Absolute path to the shell executable (or bare name resolvable via PATH).
    pub command: String,
    /// Arguments passed to the shell (e.g. ["-il"]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Profile kind: "local" (default) or "ssh".
    #[serde(default = "default_kind", skip_serializing_if = "is_kind_local")]
    pub kind: String,
    /// SSH connection parameters — present only when `kind == "ssh"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_config: Option<SshConfig>,
}

impl ShellProfile {
    /// Return the display name, falling back to the id.
    pub fn display_name(&self) -> &str {
        if self.name.is_empty() { &self.id } else { &self.name }
    }

    /// Validate and sanitize a raw profile into a canonical form.
    ///
    /// - `id` must be non-empty; whitespace is trimmed.
    /// - For local profiles, `command` must be non-empty.
    /// - For SSH profiles, `command` defaults to "ssh"; `sshConfig.host` must be present.
    /// - `name` and `args` are optional.
    ///
    /// Returns `None` if required fields are missing.
    pub fn sanitize(candidate: &Value) -> Option<Self> {
        let obj = candidate.as_object()?;

        let id = obj.get("id").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())?;
        let name = obj.get("name").and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
        let args = obj
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.chars().filter(|c| !c.is_control()).collect::<String>())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        let kind = obj.get("kind")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("local")
            .to_string();

        let is_ssh = kind == "ssh";

        let command = if is_ssh {
            obj.get("command")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("ssh")
                .to_string()
        } else {
            let raw = obj.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
            let cmd = cleaned.trim();
            if cmd.is_empty() || cmd.starts_with('-') { return None; }
            cmd.to_string()
        };

        let ssh_config = if is_ssh {
            let sc = (|| -> Option<SshConfig> {
                let sc_obj = obj.get("sshConfig")?.as_object()?;
                let host = sc_obj.get("host")?.as_str()?.trim();
                if host.is_empty() || host.starts_with('-') { return None; }
                let port = sc_obj.get("port").and_then(|v| v.as_u64()).map(|p| p as u16);
                let user = sc_obj.get("user").and_then(|v| v.as_str())
                    .map(str::trim).filter(|s| !s.is_empty() && !s.starts_with('-')).map(String::from);
                let identity_file = sc_obj.get("identityFile").and_then(|v| v.as_str())
                    .map(str::trim).filter(|s| !s.is_empty() && !s.starts_with('-')).map(String::from);
                Some(SshConfig { host: host.to_string(), port, user, identity_file })
            })();
            if sc.is_none() { return None; }
            sc
        } else {
            None
        };

        // For SSH profiles, restrict args to a safe whitelist to prevent
        // options like -o ProxyCommand from being injected.
        let args = if is_ssh { sanitize_ssh_args(args) } else { args };

        Some(Self { id: id.to_string(), name, command, args, kind, ssh_config })
    }
}

/// Filter SSH profile args to a safe whitelist.
///
/// Allowed: `-t`, `--`, `-p <port>`, `-i <path>`, `-l <user>`, bare positional
/// strings (hostname / user@host). Everything else is silently dropped so that
/// dangerous options like `-o ProxyCommand=...` can never be injected.
fn sanitize_ssh_args(args: Vec<String>) -> Vec<String> {
    // Flags that stand alone (no following value).
    const STANDALONE: &[&str] = &["-t", "--"];
    // Flags that each consume one following value.
    const WITH_VALUE: &[&str] = &["-p", "-i", "-l"];

    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if STANDALONE.contains(&arg.as_str()) {
            out.push(arg.clone());
            i += 1;
        } else if WITH_VALUE.contains(&arg.as_str()) {
            if let Some(val) = args.get(i + 1) {
                let valid = match arg.as_str() {
                    "-p" => val.parse::<u16>().map(|p| p > 0).unwrap_or(false),
                    _ => !val.is_empty() && !val.starts_with('-'),
                };
                if valid {
                    out.push(arg.clone());
                    out.push(val.clone());
                }
                i += 2;
            } else {
                i += 1; // dangling flag without value
            }
        } else if !arg.starts_with('-') {
            out.push(arg.clone()); // positional: hostname / user@host
            i += 1;
        } else {
            i += 1; // unknown/dangerous flag — drop
        }
    }
    out
}

/// Sanitize a list of shell profiles, deduplicating by id.
/// Profiles with invalid id or command are silently dropped.
fn sanitize_shell_profiles(profiles: Option<&Value>) -> Vec<ShellProfile> {
    let arr = profiles.and_then(|v| v.as_array());
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    if let Some(arr) = arr {
        for item in arr {
            if let Some(p) = ShellProfile::sanitize(item) {
                if seen.insert(p.id.clone()) {
                    result.push(p);
                }
            }
        }
    }

    result
}

/// Sanitize the `shell` block of a config.
///
/// Ensures `defaultProfile` refers to an existing profile. If the
/// referenced id is missing or the field is absent, falls back to
/// the first profile's id (or an empty string if no profiles exist).
fn sanitize_shell_config(
    shell: Option<&Value>,
    profiles: &[ShellProfile],
) -> Value {
    let raw_default = shell
        .and_then(|s| s.as_object())
        .and_then(|o| o.get("defaultProfile"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");

    let default_id = if !raw_default.is_empty() && profiles.iter().any(|p| p.id == raw_default) {
        raw_default.to_string()
    } else {
        profiles.first().map(|p| p.id.clone()).unwrap_or_default()
    };

    serde_json::json!({
        "profiles": profiles,
        "defaultProfile": default_id,
    })
}

/// Resolve the path to `settings.json` inside the app data directory.
pub(super) fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
        .map(|p: std::path::PathBuf| p.join("settings.json"))
}

/// Clamp a UI field from an arbitrary JSON value, falling back to `default`.
fn get_number(v: &Value, key: &str, default: f64) -> f64 {
    v.get(key)
        .and_then(|n| n.as_f64())
        .filter(|n| n.is_finite())
        .unwrap_or(default)
}

/// Sanitize the `ui` block of a config, clamping all values to valid ranges.
fn sanitize_ui_config(ui: Option<&Value>) -> Value {
    let ui = ui.unwrap_or(&Value::Null);

    let font_size = get_number(ui, "fontSize", DEFAULT_FONT_SIZE as f64);
    let font_size = font_size.round().clamp(10.0, 24.0) as u32;

    let pane_opacity = get_number(ui, "paneOpacity", DEFAULT_PANE_OPACITY);
    let pane_opacity = ((pane_opacity * 100.0).round() / 100.0).clamp(0.55, 1.0);

    let pane_mask_opacity = get_number(ui, "paneMaskOpacity", 0.25);
    let pane_mask_opacity = ((pane_mask_opacity * 100.0).round() / 100.0).clamp(0.0, 1.0);

    let pane_width = get_number(ui, "paneWidth", DEFAULT_PANE_WIDTH as f64);
    let pane_width = ((pane_width / 10.0).round() * 10.0).clamp(520.0, 2000.0) as u32;

    let font_family = ui
        .get("fontFamily")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");

    let mut result = serde_json::json!({
        "fontSize": font_size,
        "paneOpacity": pane_opacity,
        "paneMaskOpacity": pane_mask_opacity,
        "paneWidth": pane_width,
    });

    // Helper: insert into the result object (always safe — result is json!({})).
    let obj = result.as_object_mut().expect("json!({}) is always an Object");

    if !font_family.is_empty() {
        obj.insert("fontFamily".into(), Value::String(font_family.to_string()));
    }

    // Preserve keyboard shortcuts if present
    if let Some(shortcuts) = ui.get("shortcuts").and_then(|v| v.as_object()) {
        obj.insert("shortcuts".into(), Value::Object(shortcuts.clone()));
    }

    // Preserve language setting
    const VALID_LANGS: &[&str] = &["en", "zh-CN", "zh-TW", "ja"];
    if let Some(lang) = ui.get("language").and_then(|v| v.as_str()) {
        if VALID_LANGS.contains(&lang) {
            obj.insert("language".into(), Value::String(lang.to_string()));
        }
    }

    // Preserve copyOnSelect boolean
    if let Some(v) = ui.get("copyOnSelect").and_then(|v| v.as_bool()) {
        obj.insert("copyOnSelect".into(), Value::Bool(v));
    }

    // Preserve rightClickPaste boolean
    if let Some(v) = ui.get("rightClickPaste").and_then(|v| v.as_bool()) {
        obj.insert("rightClickPaste".into(), Value::Bool(v));
    }

    // Preserve ambiguousDouble boolean
    if let Some(v) = ui.get("ambiguousDouble").and_then(|v| v.as_bool()) {
        obj.insert("ambiguousDouble".into(), Value::Bool(v));
    }

    // Preserve showStatusBar boolean
    if let Some(show) = ui.get("showStatusBar").and_then(|v| v.as_bool()) {
        obj.insert("showStatusBar".into(), Value::Bool(show));
    }

    // Preserve status bar format and hints strings
    if let Some(fmt) = ui.get("statusBarFormat").and_then(|v| v.as_str()) {
        obj.insert("statusBarFormat".into(), Value::String(fmt.to_string()));
    }
    if let Some(hints) = ui.get("statusBarHints").and_then(|v| v.as_str()) {
        obj.insert("statusBarHints".into(), Value::String(hints.to_string()));
    }

    // Preserve colorMode string
    const VALID_COLOR_MODES: &[&str] = &["dark", "light", "auto"];
    if let Some(mode) = ui.get("colorMode").and_then(|v| v.as_str()) {
        if VALID_COLOR_MODES.contains(&mode) {
            obj.insert("colorMode".into(), Value::String(mode.to_string()));
        }
    }

    // Preserve scrollback line count (1000..=50000)
    if let Some(v) = ui.get("scrollback").and_then(|v| v.as_f64()) {
        let clamped = v.round().clamp(1000.0, 50000.0) as u64;
        obj.insert("scrollback".into(), Value::Number(clamped.into()));
    }

    result
}

/// Read whether the saved color mode is "light" from the settings file.
/// Falls back to false (dark) when the setting is absent or unparseable.
/// Used at startup to initialize IS_LIGHT_MODE before JS runs.
pub fn get_saved_is_light(app: &AppHandle) -> bool {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.get("ui")
                .and_then(|ui| ui.get("colorMode"))
                .and_then(|m| m.as_str())
                .map(|m| m == "light")
        })
        .unwrap_or(false)
}

/// Read whether the status bar should be shown from the settings file.
/// Falls back to false when the setting is absent or unparseable.
/// Used at startup to initialize the "Show Status Bar" CheckMenuItem before JS runs.
pub fn get_saved_show_status_bar(app: &AppHandle) -> bool {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.get("ui")
                .and_then(|ui| ui.get("showStatusBar"))
                .and_then(|b| b.as_bool())
        })
        .unwrap_or(false)
}

/// Read the saved language code from the settings file without full sanitization.
/// Falls back to the macOS system language when the setting is absent.
/// Used at startup to localise native menu items before settings are fully loaded.
pub fn get_saved_language(app: &AppHandle) -> String {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.get("ui")
                .and_then(|ui| ui.get("language"))
                .and_then(|l| l.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(get_system_language)
}

/// Detect the system display language.
/// Returns one of "zh-CN", "zh-TW", "ja", or "en".
fn get_system_language() -> String {
    #[cfg(target_os = "macos")]
    {
        // `defaults read -g AppleLanguages` returns an array like ("zh-Hans-US", "en-US")
        let output = std::process::Command::new("defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
            .ok();

        if let Some(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            if text.contains("zh-Hans") || text.contains("zh-CN") {
                return "zh-CN".to_string();
            }
            if text.contains("zh-Hant") || text.contains("zh-TW") {
                return "zh-TW".to_string();
            }
            if text.contains("\"ja\"") || text.contains("ja-") {
                return "ja".to_string();
            }
        }
    }

    // Fallback: LANG env var (e.g. "zh_CN.UTF-8")
    std::env::var("LANG")
        .map(|l| {
            if l.contains("zh_CN") { "zh-CN".to_string() }
            else if l.contains("zh_TW") { "zh-TW".to_string() }
            else if l.starts_with("ja_") { "ja".to_string() }
            else { "en".to_string() }
        })
        .unwrap_or_else(|_| "en".to_string())
}

/// Sanitize the `session` block of a config.
///
/// Validates that each pane entry has a valid `accent` hex color.
/// Returns `Value::Null` if the session is missing, empty, or has no valid panes.
fn sanitize_session(session: Option<&Value>) -> Value {
    let panes = match session
        .and_then(|s| s.as_object())
        .and_then(|o| o.get("panes"))
        .and_then(|p| p.as_array())
    {
        Some(arr) => arr,
        None => return Value::Null,
    };

    let valid: Vec<Value> = panes
        .iter()
        .filter(|p| {
            p.get("accent")
                .and_then(|v| v.as_str())
                .is_some_and(|s| s.starts_with('#') && s.len() == 7 && s[1..].chars().all(|c| c.is_ascii_hexdigit()))
        })
        .cloned()
        .collect();

    if valid.is_empty() {
        return Value::Null;
    }

    let focused_index = session
        .and_then(|s| s.as_object())
        .and_then(|o| o.get("focusedPaneIndex"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;

    let focused_index = focused_index.min(valid.len() - 1);

    serde_json::json!({
        "panes": valid,
        "focusedPaneIndex": focused_index,
    })
}

/// Sanitize an arbitrary config value into the current schema.
///
/// Handles:
/// - Current versioned format (`{ version: 2, ui: { ... }, shell: { ... } }`)
/// - Version 1 format (`{ version: 1, ui: { ... } }`) → promoted to v2
/// - Legacy flat format (`{ fontSize, paneOpacity, paneWidth }` without version/ui)
/// - Null / invalid input → defaults
pub(crate) fn sanitize_config(candidate: &Value) -> Value {
    let version = candidate
        .as_object()
        .and_then(|o| o.get("version"))
        .and_then(|v| v.as_u64());

    // version.is_some() implies candidate is a JSON object (from the .and_then chain above),
    // so as_object() is guaranteed to succeed in the Some(_) arms.
    match version {
        Some(v) if v >= 2 => {
            // Version 2+ format: sanitize ui, shell, and optionally session blocks.
            let Some(obj) = candidate.as_object() else { unreachable!() };
            let profiles = sanitize_shell_profiles(obj.get("shell").and_then(|s| s.get("profiles")));
            let session = sanitize_session(obj.get("session"));

            let mut result = serde_json::json!({
                "version": CURRENT_CONFIG_VERSION,
                "ui": sanitize_ui_config(obj.get("ui")),
                "shell": sanitize_shell_config(obj.get("shell"), &profiles),
            });

            if !session.is_null() {
                result
                    .as_object_mut()
                    .expect("json!({}) is always an Object")
                    .insert("session".into(), session);
            }

            result
        }
        Some(v) if v == 1 => {
            // Version 1 → 2 migration: preserve ui, add empty shell block.
            let Some(obj) = candidate.as_object() else { unreachable!() };
            serde_json::json!({
                "version": CURRENT_CONFIG_VERSION,
                "ui": sanitize_ui_config(obj.get("ui")),
                "shell": {
                    "profiles": [],
                    "defaultProfile": "",
                },
            })
        }
        _ => {
            // Check for legacy flat format (fields at top level, no version/ui nesting)
            if candidate.as_object().is_some_and(|obj| {
                obj.keys().any(|k| ["fontSize", "paneOpacity", "paneWidth"].contains(&k.as_str()))
            }) {
                return serde_json::json!({
                    "version": CURRENT_CONFIG_VERSION,
                    "ui": sanitize_ui_config(Some(candidate)),
                    "shell": {
                        "profiles": [],
                        "defaultProfile": "",
                    },
                });
            }

            // Null, non-object, or unrecognized format → defaults
            serde_json::json!({
                "version": CURRENT_CONFIG_VERSION,
                "ui": {
                    "fontSize": DEFAULT_FONT_SIZE,
                    "paneOpacity": DEFAULT_PANE_OPACITY,
                    "paneMaskOpacity": 0.25,
                    "paneWidth": DEFAULT_PANE_WIDTH,
                },
                "shell": {
                    "profiles": [],
                    "defaultProfile": "",
                },
            })
        }
    }
}

/// Set the native window theme (dark / light / auto) at runtime.
#[tauri::command]
pub fn set_window_theme(app: AppHandle, mode: String) -> Result<(), String> {
    use tauri::{Theme, window::Color};

    // Record the theme so the on_window_event Resized handler can read it
    // without needing an IPC round-trip.
    crate::IS_LIGHT_MODE.store(
        mode == "light",
        std::sync::atomic::Ordering::Release,
    );

    let window = app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let theme = match mode.as_str() {
        "dark"  => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _       => None,
    };
    window.set_theme(theme).map_err(|e| format!("set_theme failed: {e}"))?;
    // Sync the WKWebView underPageBackgroundColor (overscroll colour).
    let bg = match mode.as_str() {
        "light" => Color(235, 229, 221, 255),
        _       => Color(16,  16,  16,  255),
    };
    window.set_background_color(Some(bg)).map_err(|e| format!("set_background_color failed: {e}"))?;
    // Also set NSWindow.backgroundColor immediately on the main thread.
    // The on_window_event Resized handler does the same thing reliably after
    // fullscreen entry, but calling it here too covers theme-change scenarios.
    #[cfg(target_os = "macos")]
    apply_ns_window_background(window.app_handle(), &mode);
    Ok(())
}

/// Schedule NSWindow.backgroundColor = theme colour on the main thread.
/// Must be called from ANY thread; dispatches via run_on_main_thread.
#[cfg(target_os = "macos")]
pub fn apply_ns_window_background(app: &AppHandle, mode: &str) {
    let is_light = mode == "light";
    if let Some(win) = app.get_webview_window("main") {
        let win2 = win.clone();
        let _ = win.run_on_main_thread(move || {
            if let Ok(ptr) = win2.ns_window() {
                set_ns_window_bg_ptr(ptr, is_light);
            }
        });
    }
}

/// Set the native window background AND the WryWebViewParent CALayer color.
///
/// The black strip visible in macOS fullscreen is NOT the NSWindow background —
/// it is the CALayer.backgroundColor of the WryWebViewParent NSView that wry
/// inserts as the content view (wry/src/wkwebview/mod.rs ~line 685).
/// WKWebView itself has drawsBackground=false (transparent), so whatever is
/// behind it shows through.  WryWebViewParent's CALayer defaults to opaque
/// black, which is what appears during fullscreen when the WKWebView doesn't
/// momentarily cover every pixel.
///
/// Must be called on the main thread.
#[cfg(target_os = "macos")]
pub fn set_ns_window_bg_ptr(ptr: *mut std::ffi::c_void, is_light: bool) {
    let (r, g, b) = if is_light {
        (235.0_f64 / 255.0, 229.0_f64 / 255.0, 221.0_f64 / 255.0)
    } else {
        (16.0_f64 / 255.0, 16.0_f64 / 255.0, 16.0_f64 / 255.0)
    };
    unsafe {
        use objc2::runtime::AnyObject;
        use objc2::msg_send;
        use objc2_app_kit::{NSColor, NSWindow};

        let ns_win: &NSWindow = &*(ptr as *const NSWindow);
        let color = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0);

        // 1. NSWindow.backgroundColor — covers the narrow region behind the
        //    content view during resize/animation.
        ns_win.setBackgroundColor(Some(&color));

        // 2. WryWebViewParent CALayer — this view is set as NSWindow.contentView
        //    by wry. Its CALayer defaults to opaque black, which shows through
        //    the transparent WKWebView in the strip below the CSS viewport.
        let content_view: *mut AnyObject = msg_send![ns_win, contentView];
        if !content_view.is_null() {
            let () = msg_send![content_view, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![content_view, layer];
            if !layer.is_null() {
                let cg_color: *mut AnyObject = msg_send![&color, CGColor];
                let () = msg_send![layer, setBackgroundColor: cg_color];
            }

            let subviews: *mut AnyObject = msg_send![content_view, subviews];
            let count: usize = msg_send![subviews, count];
            for i in 0..count {
                let sv: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
                let () = msg_send![sv, setWantsLayer: true];
                let sv_layer: *mut AnyObject = msg_send![sv, layer];
                if !sv_layer.is_null() {
                    let cg_color: *mut AnyObject = msg_send![&color, CGColor];
                    let () = msg_send![sv_layer, setBackgroundColor: cg_color];
                }
                let () = msg_send![sv, setUnderPageBackgroundColor: &*color];
            }
        }
    }
}

/// Walk the WKWebView layer hierarchy and set preferredFrameRateRange to allow
/// up to 120 Hz rendering on ProMotion displays (macOS 12+).
///
/// wry places the WKWebView as subviews[0] of the NSWindow contentView.
/// Must be called on the main thread.
#[cfg(target_os = "macos")]
pub fn configure_promotion_frame_rate(ns_window_ptr: *mut std::ffi::c_void) {
    // CAFrameRateRange — available since macOS 12. Three f32 fields.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CAFrameRateRange { minimum: f32, maximum: f32, preferred: f32 }
    unsafe impl objc2::encode::Encode for CAFrameRateRange {
        const ENCODING: objc2::encode::Encoding = objc2::encode::Encoding::Struct(
            "CAFrameRateRange",
            &[f32::ENCODING, f32::ENCODING, f32::ENCODING],
        );
    }

    unsafe {
        use objc2::runtime::AnyObject;
        use objc2::msg_send;
        use objc2::sel;
        use objc2_app_kit::NSWindow;

        let ns_win: &NSWindow = &*(ns_window_ptr as *const NSWindow);
        let content_view: *mut AnyObject = msg_send![ns_win, contentView];
        if content_view.is_null() { return; }

        let subviews: *mut AnyObject = msg_send![content_view, subviews];
        let count: usize = msg_send![subviews, count];
        if count == 0 { return; }

        // WKWebView is the first subview of the wry WryWebViewParent
        let webview: *mut AnyObject = msg_send![subviews, objectAtIndex: 0usize];
        let () = msg_send![webview, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![webview, layer];
        if layer.is_null() { return; }

        // Runtime guard: setPreferredFrameRateRange: only exists on macOS 12+
        let sel = sel!(setPreferredFrameRateRange:);
        let responds: bool = msg_send![layer, respondsToSelector: sel];
        if !responds { return; }

        // minimum=0 means no floor; maximum=120 cap; preferred=0 means "maximum available"
        let range = CAFrameRateRange { minimum: 0.0, maximum: 120.0, preferred: 0.0 };
        let () = msg_send![layer, setPreferredFrameRateRange: range];
    }
}

/// Load the application settings from disk.
///
/// Returns the sanitized config. If the file does not exist or cannot be
/// parsed, the default config is returned instead.
#[tauri::command]
pub fn settings_load(app: AppHandle) -> Result<Value, String> {
    let path = settings_path(&app)?;

    if !path.exists() {
        return Ok(sanitize_config(&Value::Null));
    }

    // Refuse to parse files larger than 10 MB to prevent startup DoS.
    const MAX_SETTINGS_BYTES: u64 = 10 * 1024 * 1024;
    let file_len = std::fs::metadata(&path)
        .map(|m| m.len())
        .unwrap_or(0);
    if file_len > MAX_SETTINGS_BYTES {
        return Ok(sanitize_config(&Value::Null));
    }

    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("failed to read settings: {e}"))?;

    let parsed: Value =
        serde_json::from_str(&contents).unwrap_or_else(|_| sanitize_config(&Value::Null));

    Ok(sanitize_config(&parsed))
}

/// Save application settings to disk.
///
/// The input is sanitized before writing, so the returned value is the
/// canonical representation that was persisted.
#[tauri::command]
pub fn settings_save(app: AppHandle, mut settings: Value) -> Result<Value, String> {
    let _guard = acquire_settings_lock();
    let path = settings_path(&app)?;

    // Create parent directory if it doesn't exist
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create settings directory: {e}"))?;
    }

    // The frontend may send a partial payload without `shell` or `session`.
    // Preserve both blocks from disk so user-edited profiles and the main
    // window's session are not silently wiped by a non-main window save.
    let missing_shell = settings.get("shell").is_none();
    let missing_session = settings.get("session").is_none();
    if (missing_shell || missing_session) && path.exists() {
        if let Some(existing) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        {
            if let Some(obj) = settings.as_object_mut() {
                if missing_shell {
                    if let Some(v) = existing.get("shell").cloned() { obj.insert("shell".into(), v); }
                }
                if missing_session {
                    if let Some(v) = existing.get("session").cloned() { obj.insert("session".into(), v); }
                }
            }
        }
    }

    let sanitized = sanitize_config(&settings);
    let serialized =
        serde_json::to_string_pretty(&sanitized).map_err(|e| format!("failed to serialize settings: {e}"))?;

    std::fs::write(&path, serialized).map_err(|e| format!("failed to write settings: {e}"))?;

    Ok(sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ver() -> u64 { CURRENT_CONFIG_VERSION as u64 }
    fn ui_of(cfg: &Value) -> &Value { cfg.get("ui").unwrap() }
    fn shell_of(cfg: &Value) -> &Value { cfg.get("shell").unwrap() }

    fn v2(ui: Value) -> Value {
        json!({ "version": 2, "ui": ui, "shell": { "profiles": [], "defaultProfile": "" } })
    }

    // ── sanitize_config: null / defaults ──────────────────────────────────

    #[test]
    fn null_returns_versioned_defaults() {
        let r = sanitize_config(&Value::Null);
        assert_eq!(r["version"].as_u64().unwrap(), ver());
        assert_eq!(ui_of(&r)["fontSize"].as_u64().unwrap(), DEFAULT_FONT_SIZE as u64);
        assert!((ui_of(&r)["paneOpacity"].as_f64().unwrap() - DEFAULT_PANE_OPACITY).abs() < 0.01);
        assert_eq!(ui_of(&r)["paneWidth"].as_u64().unwrap(), DEFAULT_PANE_WIDTH as u64);
        assert_eq!(shell_of(&r)["profiles"].as_array().unwrap().len(), 0);
        assert_eq!(shell_of(&r)["defaultProfile"].as_str().unwrap(), "");
    }

    #[test]
    fn non_object_returns_defaults() {
        assert_eq!(sanitize_config(&json!(42))["version"].as_u64().unwrap(), ver());
        assert_eq!(sanitize_config(&json!("string"))["version"].as_u64().unwrap(), ver());
    }

    // ── legacy flat format ────────────────────────────────────────────────

    #[test]
    fn legacy_flat_format_promoted() {
        let input = json!({ "fontSize": 16, "paneOpacity": 0.9, "paneWidth": 800 });
        let r = sanitize_config(&input);
        assert_eq!(r["version"].as_u64().unwrap(), ver());
        assert_eq!(ui_of(&r)["fontSize"].as_u64().unwrap(), 16);
        assert_eq!(shell_of(&r)["profiles"].as_array().unwrap().len(), 0);
    }

    // ── version migration ─────────────────────────────────────────────────

    #[test]
    fn v1_migrated_to_current() {
        let input = json!({ "version": 1, "ui": { "fontSize": 14 } });
        let r = sanitize_config(&input);
        assert_eq!(r["version"].as_u64().unwrap(), ver());
        assert_eq!(ui_of(&r)["fontSize"].as_u64().unwrap(), 14);
        assert_eq!(shell_of(&r)["profiles"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn v2_passthrough_preserves_ui() {
        let r = sanitize_config(&v2(json!({ "fontSize": 15 })));
        assert_eq!(ui_of(&r)["fontSize"].as_u64().unwrap(), 15);
    }

    // ── font size clamping ────────────────────────────────────────────────

    #[test]
    fn font_size_clamped_low() {
        let r = sanitize_config(&v2(json!({ "fontSize": 5 })));
        assert_eq!(ui_of(&r)["fontSize"].as_u64().unwrap(), 10);
    }

    #[test]
    fn font_size_clamped_high() {
        let r = sanitize_config(&v2(json!({ "fontSize": 99 })));
        assert_eq!(ui_of(&r)["fontSize"].as_u64().unwrap(), 24);
    }

    #[test]
    fn font_size_within_range_preserved() {
        let r = sanitize_config(&v2(json!({ "fontSize": 18 })));
        assert_eq!(ui_of(&r)["fontSize"].as_u64().unwrap(), 18);
    }

    #[test]
    fn font_size_nan_falls_back_to_default() {
        let r = sanitize_config(&v2(json!({ "fontSize": "large" })));
        assert_eq!(ui_of(&r)["fontSize"].as_u64().unwrap(), DEFAULT_FONT_SIZE as u64);
    }

    // ── pane opacity clamping ─────────────────────────────────────────────

    #[test]
    fn pane_opacity_clamped_low() {
        let r = sanitize_config(&v2(json!({ "paneOpacity": 0.0 })));
        let v = ui_of(&r)["paneOpacity"].as_f64().unwrap();
        assert!((v - 0.55).abs() < 0.01);
    }

    #[test]
    fn pane_opacity_clamped_high() {
        let r = sanitize_config(&v2(json!({ "paneOpacity": 2.0 })));
        let v = ui_of(&r)["paneOpacity"].as_f64().unwrap();
        assert!((v - 1.0).abs() < 0.01);
    }

    #[test]
    fn pane_opacity_rounds_to_two_decimals() {
        let r = sanitize_config(&v2(json!({ "paneOpacity": 0.756 })));
        let v = ui_of(&r)["paneOpacity"].as_f64().unwrap();
        // 0.756 * 100 = 75.6 → round = 76 → 0.76
        assert!((v - 0.76).abs() < 0.001);
    }

    // ── pane width clamping ───────────────────────────────────────────────

    #[test]
    fn pane_width_clamped_low() {
        let r = sanitize_config(&v2(json!({ "paneWidth": 100 })));
        assert_eq!(ui_of(&r)["paneWidth"].as_u64().unwrap(), 520);
    }

    #[test]
    fn pane_width_clamped_high() {
        let r = sanitize_config(&v2(json!({ "paneWidth": 5000 })));
        assert_eq!(ui_of(&r)["paneWidth"].as_u64().unwrap(), 2000);
    }

    #[test]
    fn pane_width_snaps_to_nearest_10() {
        let r = sanitize_config(&v2(json!({ "paneWidth": 723 })));
        let w = ui_of(&r)["paneWidth"].as_u64().unwrap();
        assert_eq!(w, 720); // 72.3 → round to 72 → 720
        assert_eq!(w % 10, 0);
    }

    // ── language validation ───────────────────────────────────────────────

    #[test]
    fn valid_languages_preserved() {
        for lang in ["en", "zh-CN", "zh-TW", "ja"] {
            let r = sanitize_config(&v2(json!({ "language": lang })));
            assert_eq!(ui_of(&r)["language"].as_str().unwrap(), lang);
        }
    }

    #[test]
    fn invalid_language_dropped() {
        let r = sanitize_config(&v2(json!({ "language": "fr" })));
        assert!(ui_of(&r).get("language").is_none());
    }

    // ── color mode validation ─────────────────────────────────────────────

    #[test]
    fn valid_color_modes_preserved() {
        for mode in ["dark", "light", "auto"] {
            let r = sanitize_config(&v2(json!({ "colorMode": mode })));
            assert_eq!(ui_of(&r)["colorMode"].as_str().unwrap(), mode);
        }
    }

    #[test]
    fn invalid_color_mode_dropped() {
        let r = sanitize_config(&v2(json!({ "colorMode": "purple" })));
        assert!(ui_of(&r).get("colorMode").is_none());
    }

    // ── boolean settings ──────────────────────────────────────────────────

    #[test]
    fn boolean_settings_round_trip() {
        let r = sanitize_config(&v2(json!({
            "copyOnSelect": true,
            "rightClickPaste": false,
            "ambiguousDouble": true,
            "showStatusBar": true,
        })));
        let ui = ui_of(&r);
        assert_eq!(ui["copyOnSelect"].as_bool().unwrap(), true);
        assert_eq!(ui["rightClickPaste"].as_bool().unwrap(), false);
        assert_eq!(ui["ambiguousDouble"].as_bool().unwrap(), true);
        assert_eq!(ui["showStatusBar"].as_bool().unwrap(), true);
    }

    // ── scrollback clamping ───────────────────────────────────────────────

    #[test]
    fn scrollback_clamped_low() {
        let r = sanitize_config(&v2(json!({ "scrollback": 100 })));
        assert_eq!(ui_of(&r)["scrollback"].as_u64().unwrap(), 1000);
    }

    #[test]
    fn scrollback_clamped_high() {
        let r = sanitize_config(&v2(json!({ "scrollback": 999999 })));
        assert_eq!(ui_of(&r)["scrollback"].as_u64().unwrap(), 50000);
    }

    #[test]
    fn scrollback_in_range_preserved() {
        let r = sanitize_config(&v2(json!({ "scrollback": 5000 })));
        assert_eq!(ui_of(&r)["scrollback"].as_u64().unwrap(), 5000);
    }

    // ── font family ───────────────────────────────────────────────────────

    #[test]
    fn font_family_preserved() {
        let r = sanitize_config(&v2(json!({ "fontFamily": "Fira Code" })));
        assert_eq!(ui_of(&r)["fontFamily"].as_str().unwrap(), "Fira Code");
    }

    #[test]
    fn whitespace_only_font_family_dropped() {
        let r = sanitize_config(&v2(json!({ "fontFamily": "   " })));
        assert!(ui_of(&r).get("fontFamily").is_none());
    }

    // ── ShellProfile::sanitize ────────────────────────────────────────────

    #[test]
    fn shell_profile_valid_local() {
        let v = json!({ "id": "zsh", "command": "/bin/zsh", "args": ["-il"] });
        let p = ShellProfile::sanitize(&v).unwrap();
        assert_eq!(p.id, "zsh");
        assert_eq!(p.command, "/bin/zsh");
        assert_eq!(p.args, vec!["-il"]);
        assert_eq!(p.kind, "local");
        assert!(p.ssh_config.is_none());
    }

    #[test]
    fn shell_profile_missing_id_rejected() {
        assert!(ShellProfile::sanitize(&json!({ "command": "/bin/bash" })).is_none());
    }

    #[test]
    fn shell_profile_whitespace_id_rejected() {
        assert!(ShellProfile::sanitize(&json!({ "id": "  ", "command": "/bin/bash" })).is_none());
    }

    #[test]
    fn shell_profile_empty_command_rejected() {
        assert!(ShellProfile::sanitize(&json!({ "id": "x", "command": "" })).is_none());
    }

    #[test]
    fn shell_profile_command_starting_with_dash_rejected() {
        assert!(ShellProfile::sanitize(&json!({ "id": "x", "command": "-rm" })).is_none());
    }

    #[test]
    fn shell_profile_control_chars_stripped_from_command() {
        let v = json!({ "id": "x", "command": "/bin/zsh\x00\x01" });
        let p = ShellProfile::sanitize(&v).unwrap();
        assert_eq!(p.command, "/bin/zsh");
    }

    #[test]
    fn shell_profile_ssh_defaults_command_to_ssh() {
        let v = json!({
            "id": "myserver", "kind": "ssh",
            "sshConfig": { "host": "example.com" }
        });
        let p = ShellProfile::sanitize(&v).unwrap();
        assert_eq!(p.command, "ssh");
        assert_eq!(p.kind, "ssh");
        assert_eq!(p.ssh_config.as_ref().unwrap().host, "example.com");
    }

    #[test]
    fn shell_profile_ssh_missing_host_rejected() {
        let v = json!({ "id": "s", "kind": "ssh", "sshConfig": { "host": "" } });
        assert!(ShellProfile::sanitize(&v).is_none());
    }

    #[test]
    fn shell_profile_ssh_host_starts_with_dash_rejected() {
        let v = json!({ "id": "s", "kind": "ssh", "sshConfig": { "host": "-proxycmd" } });
        assert!(ShellProfile::sanitize(&v).is_none());
    }

    #[test]
    fn shell_profile_ssh_missing_sshconfig_rejected() {
        let v = json!({ "id": "s", "kind": "ssh" });
        assert!(ShellProfile::sanitize(&v).is_none());
    }

    #[test]
    fn shell_profile_display_name_falls_back_to_id() {
        let p = ShellProfile {
            id: "zsh".into(), name: "".into(), command: "/bin/zsh".into(),
            args: vec![], kind: "local".into(), ssh_config: None,
        };
        assert_eq!(p.display_name(), "zsh");
    }

    #[test]
    fn shell_profile_display_name_uses_name_when_set() {
        let p = ShellProfile {
            id: "zsh".into(), name: "My Shell".into(), command: "/bin/zsh".into(),
            args: vec![], kind: "local".into(), ssh_config: None,
        };
        assert_eq!(p.display_name(), "My Shell");
    }

    // ── sanitize_ssh_args ─────────────────────────────────────────────────

    fn ssh_profile_args(args: Vec<&str>) -> Vec<String> {
        let v = json!({
            "id": "s", "kind": "ssh",
            "sshConfig": { "host": "example.com" },
            "args": args,
        });
        ShellProfile::sanitize(&v).unwrap().args
    }

    #[test]
    fn ssh_args_standalone_t_allowed() {
        assert!(ssh_profile_args(vec!["-t"]).contains(&"-t".to_string()));
    }

    #[test]
    fn ssh_args_dash_dash_allowed() {
        assert!(ssh_profile_args(vec!["--"]).contains(&"--".to_string()));
    }

    #[test]
    fn ssh_args_p_with_valid_port_allowed() {
        let args = ssh_profile_args(vec!["-p", "22"]);
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"22".to_string()));
    }

    #[test]
    fn ssh_args_p_with_invalid_port_dropped() {
        let args = ssh_profile_args(vec!["-p", "99999"]);
        assert!(!args.contains(&"-p".to_string()));
    }

    #[test]
    fn ssh_args_dangerous_o_flag_dropped() {
        // -o is not in the allowlist and is dropped; its value is treated as a
        // positional (hostname), which is safe — SSH won't interpret it as an option.
        let args = ssh_profile_args(vec!["-o", "ProxyCommand=evil"]);
        assert!(!args.contains(&"-o".to_string()));
        // The value "ProxyCommand=evil" passes through as a positional hostname arg.
        // This is safe: it's not a flag, and SSH would just try to connect to that hostname.
    }

    #[test]
    fn ssh_args_bare_hostname_allowed() {
        let args = ssh_profile_args(vec!["user@host"]);
        assert!(args.contains(&"user@host".to_string()));
    }

    #[test]
    fn ssh_args_i_with_path_allowed() {
        let args = ssh_profile_args(vec!["-i", "~/.ssh/id_rsa"]);
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"~/.ssh/id_rsa".to_string()));
    }

    #[test]
    fn ssh_args_l_with_user_allowed() {
        let args = ssh_profile_args(vec!["-l", "ubuntu"]);
        assert!(args.contains(&"-l".to_string()));
        assert!(args.contains(&"ubuntu".to_string()));
    }

    #[test]
    fn ssh_args_dangling_flag_without_value_dropped() {
        let args = ssh_profile_args(vec!["-p"]);
        assert!(!args.contains(&"-p".to_string()));
    }

    // ── defaultProfile resolution ─────────────────────────────────────────

    #[test]
    fn default_profile_falls_back_to_first_when_missing() {
        let input = json!({
            "version": 2, "ui": {},
            "shell": {
                "profiles": [
                    { "id": "zsh", "command": "/bin/zsh" },
                    { "id": "bash", "command": "/bin/bash" }
                ],
                "defaultProfile": "nonexistent"
            }
        });
        assert_eq!(sanitize_config(&input)["shell"]["defaultProfile"].as_str().unwrap(), "zsh");
    }

    #[test]
    fn valid_default_profile_preserved() {
        let input = json!({
            "version": 2, "ui": {},
            "shell": {
                "profiles": [
                    { "id": "zsh", "command": "/bin/zsh" },
                    { "id": "bash", "command": "/bin/bash" }
                ],
                "defaultProfile": "bash"
            }
        });
        assert_eq!(sanitize_config(&input)["shell"]["defaultProfile"].as_str().unwrap(), "bash");
    }

    #[test]
    fn duplicate_profile_ids_deduplicated() {
        let input = json!({
            "version": 2, "ui": {},
            "shell": {
                "profiles": [
                    { "id": "zsh", "command": "/bin/zsh" },
                    { "id": "zsh", "command": "/usr/bin/zsh" }
                ],
                "defaultProfile": "zsh"
            }
        });
        assert_eq!(sanitize_config(&input)["shell"]["profiles"].as_array().unwrap().len(), 1);
    }

    // ── sanitize_session ──────────────────────────────────────────────────

    #[test]
    fn session_invalid_accents_filtered() {
        let input = json!({
            "version": 2, "ui": {},
            "shell": { "profiles": [], "defaultProfile": "" },
            "session": {
                "panes": [
                    { "accent": "#aabbcc" },
                    { "accent": "invalid" },
                    { "accent": "#XXYYZZ" },
                    { "accent": "#aabbcc99" },
                ],
                "focusedPaneIndex": 0
            }
        });
        let r = sanitize_config(&input);
        let panes = r["session"]["panes"].as_array().unwrap();
        assert_eq!(panes.len(), 1);
        assert_eq!(panes[0]["accent"].as_str().unwrap(), "#aabbcc");
    }

    #[test]
    fn session_empty_panes_excluded_from_output() {
        let input = json!({
            "version": 2, "ui": {},
            "shell": { "profiles": [], "defaultProfile": "" },
            "session": { "panes": [], "focusedPaneIndex": 0 }
        });
        let r = sanitize_config(&input);
        assert!(r.get("session").is_none());
    }

    #[test]
    fn focused_pane_index_clamped_to_last() {
        let input = json!({
            "version": 2, "ui": {},
            "shell": { "profiles": [], "defaultProfile": "" },
            "session": {
                "panes": [{ "accent": "#aabbcc" }],
                "focusedPaneIndex": 99
            }
        });
        let r = sanitize_config(&input);
        assert_eq!(r["session"]["focusedPaneIndex"].as_u64().unwrap(), 0);
    }

    #[test]
    fn session_uppercase_hex_accepted() {
        let input = json!({
            "version": 2, "ui": {},
            "shell": { "profiles": [], "defaultProfile": "" },
            "session": {
                "panes": [{ "accent": "#AABBCC" }],
                "focusedPaneIndex": 0
            }
        });
        let r = sanitize_config(&input);
        assert_eq!(r["session"]["panes"].as_array().unwrap().len(), 1);
    }
}
