#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{Emitter, Manager};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use vibe99_lib::commands::context_menu;
use vibe99_lib::commands::notification;
use vibe99_lib::commands::context_menu::MenuActionPayload;
use vibe99_lib::commands::settings;
use vibe99_lib::commands::settings::{get_saved_language, get_saved_is_light, get_saved_show_status_bar};
use vibe99_lib::commands::shell_integration;
use vibe99_lib::commands::shell_profile;
use vibe99_lib::commands::ssh_config;
use vibe99_lib::commands::terminal::{self, AppState};
use vibe99_lib::commands::wsl as wsl_cmd;
use vibe99_lib::pty::PtyManager;

static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(2);

// ── macOS dock menu ───────────────────────────────────────────────────────────
// Inject `applicationDockMenu:` into the existing wry NSApplicationDelegate
// class at runtime so macOS shows "New Window" in the Dock right-click menu.
#[cfg(target_os = "macos")]
mod dock_menu {
    use std::ffi::c_char;
    use std::sync::OnceLock;
    use std::sync::atomic::Ordering;
    use objc2::{class, msg_send, runtime::AnyObject, sel};
    use objc2::ffi::{class_replaceMethod, object_getClass, sel_registerName};
    use objc2::runtime::{AnyClass, Imp, Sel};

    static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

    // Action called when the "New Window" dock item is clicked.
    unsafe extern "C" fn new_vibe_window(
        _self: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) {
        if let Some(handle) = APP_HANDLE.get() {
            let count = crate::WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
            let label = format!("window-{}", count);
            let _ = tauri::WebviewWindowBuilder::new(
                handle,
                &label,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Vibe99")
            .inner_size(1280.0, 800.0)
            .min_inner_size(600.0, 400.0)
            .build();
        }
    }

    // NSApplicationDelegate method: return a custom dock menu.
    unsafe extern "C" fn application_dock_menu(
        this: *mut AnyObject,
        _cmd: Sel,
        _ns_app: *mut AnyObject,
    ) -> *mut AnyObject {
        let menu: *mut AnyObject = msg_send![class!(NSMenu), new];

        // Build NSString objects for title and (empty) key equivalent.
        let title: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: b"New Window\0".as_ptr() as *const c_char
        ];
        let empty: *mut AnyObject = msg_send![
            class!(NSString),
            stringWithUTF8String: b"\0".as_ptr() as *const c_char
        ];

        // Selector for the action — registered at runtime.
        let action_sel = sel!(newVibeWindow:);

        let alloc: *mut AnyObject = msg_send![class!(NSMenuItem), alloc];
        let item: *mut AnyObject = msg_send![
            alloc,
            initWithTitle: title,
            action: action_sel,
            keyEquivalent: empty
        ];

        // Target is the delegate itself (which also has newVibeWindow:).
        let () = msg_send![item, setTarget: this];
        let () = msg_send![menu, addItem: item];
        let _: *mut AnyObject = msg_send![item, autorelease];

        // Hand off memory to AppKit's autorelease pool.
        let _: *mut AnyObject = msg_send![menu, autorelease];
        menu
    }

    /// Inject `applicationDockMenu:` and `newVibeWindow:` into the wry
    /// NSApplicationDelegate class. Must be called from setup() on the main
    /// thread while the delegate object is already installed.
    ///
    /// Uses `class_replaceMethod` instead of `class_addMethod` so the
    /// implementation is installed even if a prior version of the class
    /// already carries a stub for either selector.
    pub fn install(app: &tauri::AppHandle) {
        let _ = APP_HANDLE.set(app.clone());
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            if delegate.is_null() { return; }

            let cls = object_getClass(delegate as *const AnyObject) as *mut AnyClass;
            if cls.is_null() { return; }

            // "@@:@"  → returns id (NSMenu*), self id, SEL, arg id (NSApplication*)
            let dock_sel = sel_registerName(b"applicationDockMenu:\0".as_ptr() as *const c_char)
                .expect("sel_registerName returned null");
            class_replaceMethod(
                cls,
                dock_sel,
                std::mem::transmute::<unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject, Imp>(application_dock_menu),
                b"@@:@\0".as_ptr() as *const c_char,
            );

            // "v@:@"  → void, self id, SEL, arg id (NSMenuItem sender)
            let win_sel = sel_registerName(b"newVibeWindow:\0".as_ptr() as *const c_char)
                .expect("sel_registerName returned null");
            class_replaceMethod(
                cls,
                win_sel,
                std::mem::transmute::<unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject), Imp>(new_vibe_window),
                b"v@:@\0".as_ptr() as *const c_char,
            );
        }
    }
}

#[tauri::command]
fn new_window(app: tauri::AppHandle) {
    let count = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("window-{}", count);
    let _ = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Vibe99")
    .inner_size(1280.0, 800.0)
    .min_inner_size(600.0, 400.0)
    .build();
}

fn focused_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            pty: Arc::new(PtyManager::new()),
        })
        .setup(|app| {
            // Initialize IS_LIGHT_MODE from saved settings before any Resized events fire.
            let is_light = get_saved_is_light(app.app_handle());
            vibe99_lib::IS_LIGHT_MODE.store(is_light, std::sync::atomic::Ordering::Relaxed);

            let show_status_bar = get_saved_show_status_bar(app.app_handle());

            let lang = get_saved_language(app.app_handle());
            let l = lang.as_str();

            // Helper: pick text by locale
            let ml = |zh: &'static str, ja: &'static str, en: &'static str| -> &'static str {
                if l.starts_with("zh") { zh } else if l == "ja" { ja } else { en }
            };

            // ── App menu ─────────────────────────────────────────────────
            let settings_item = MenuItemBuilder::new(ml("设置…", "設定…", "Settings…"))
                .id("settings")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Vibe99")
                .item(&PredefinedMenuItem::about(app, None, None)?)
                .separator()
                .item(&settings_item)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            // ── SSH menu ──────────────────────────────────────────────────
            let ssh_profiles = shell_profile::load_ssh_profiles(&app.app_handle());
            let ssh_config_entries = ssh_config::read_ssh_config();

            // Saved profile IDs generated by the JS "Connect" flow use "ssh-config-{alias}".
            // Exclude config entries that are already saved to avoid duplicates.
            let saved_ids: std::collections::HashSet<String> =
                ssh_profiles.iter().map(|p| p.id.clone()).collect();
            let unsaved_config: Vec<_> = ssh_config_entries
                .iter()
                .filter(|e| !saved_ids.contains(&format!("ssh-config-{}", e.alias)))
                .collect();

            let ssh_manage_item =
                MenuItemBuilder::new(ml("管理 SSH 连接…", "SSH接続を管理…", "Manage SSH Connections…"))
                    .id("ssh-connections")
                    .build(app)?;

            let mut ssh_builder = SubmenuBuilder::new(app, ml("SSH 连接", "SSH接続", "SSH"))
                .item(&ssh_manage_item);

            let mut ssh_profile_items = Vec::new();
            for p in &ssh_profiles {
                ssh_profile_items.push(
                    MenuItemBuilder::new(p.display_name())
                        .id(format!("ssh-open-{}", p.id))
                        .build(app)?,
                );
            }
            let mut ssh_config_items = Vec::new();
            for e in &unsaved_config {
                ssh_config_items.push(
                    MenuItemBuilder::new(&e.alias)
                        .id(format!("ssh-host-{}", e.alias))
                        .build(app)?,
                );
            }

            let has_any = !ssh_profile_items.is_empty() || !ssh_config_items.is_empty();
            if has_any {
                ssh_builder = ssh_builder.separator();
            }
            for item in &ssh_profile_items {
                ssh_builder = ssh_builder.item(item);
            }
            if !ssh_profile_items.is_empty() && !ssh_config_items.is_empty() {
                ssh_builder = ssh_builder.separator();
            }
            for item in &ssh_config_items {
                ssh_builder = ssh_builder.item(item);
            }
            let ssh_menu = ssh_builder.build()?;

            // ── Shell menu ────────────────────────────────────────────────
            let new_window_item = MenuItemBuilder::new(ml("新建窗口", "新しいウィンドウ", "New Window"))
                .id("new-window")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let new_tab_item = MenuItemBuilder::new(ml("新建标签页", "新しいタブ", "New Tab"))
                .id("new-pane")
                .accelerator("CmdOrCtrl+T")
                .build(app)?;
            let close_tab_item = MenuItemBuilder::new(ml("关闭标签页", "タブを閉じる", "Close Tab"))
                .id("close-pane")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let close_window_item = MenuItemBuilder::new(ml("关闭窗口", "ウィンドウを閉じる", "Close Window"))
                .id("close-window")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(app)?;
            let rename_tab_item = MenuItemBuilder::new(ml("重命名标签页…", "タブの名前を変更…", "Rename Tab…"))
                .id("rename-tab")
                .build(app)?;
            let broadcast_item = CheckMenuItemBuilder::new(ml("广播输入", "入力を一斉送信", "Broadcast Input"))
                .id("broadcast-toggle")
                .accelerator("CmdOrCtrl+Shift+B")
                .checked(false)
                .build(app)?;
            let split_right_item = MenuItemBuilder::new(ml("垂直切分", "垂直に分割", "Split Right"))
                .id("split-right")
                .accelerator("CmdOrCtrl+D")
                .build(app)?;
            let split_down_item = MenuItemBuilder::new(ml("水平切分", "水平に分割", "Split Down"))
                .id("split-down")
                .accelerator("CmdOrCtrl+Shift+D")
                .build(app)?;

            let shell_menu = SubmenuBuilder::new(app, "Shell")
                .item(&new_window_item)
                .separator()
                .item(&new_tab_item)
                .item(&close_tab_item)
                .item(&close_window_item)
                .separator()
                .item(&split_right_item)
                .item(&split_down_item)
                .separator()
                .item(&rename_tab_item)
                .separator()
                .item(&broadcast_item)
                .build()?;

            // ── Edit menu ─────────────────────────────────────────────────
            let clear_scrollback_item = MenuItemBuilder::new(
                ml("清除滚动缓冲区", "スクロールバッファをクリア", "Clear Scrollback Buffer"),
            )
            .id("clear-scrollback")
            .build(app)?;

            let edit_menu = SubmenuBuilder::new(app, ml("编辑", "編集", "Edit"))
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .separator()
                .item(&clear_scrollback_item)
                .build()?;

            // ── View menu ─────────────────────────────────────────────────
            let font_increase_item = MenuItemBuilder::new(ml("放大字体", "フォントを拡大", "Increase Font Size"))
                .id("font-size-increase")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;
            let font_decrease_item = MenuItemBuilder::new(ml("缩小字体", "フォントを縮小", "Decrease Font Size"))
                .id("font-size-decrease")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;
            let font_reset_item = MenuItemBuilder::new(ml("重置字体", "フォントをリセット", "Reset Font Size"))
                .id("font-size-reset")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;

            let appearance_light = MenuItemBuilder::new(ml("浅色", "ライト", "Light"))
                .id("appearance-light")
                .build(app)?;
            let appearance_dark = MenuItemBuilder::new(ml("深色", "ダーク", "Dark"))
                .id("appearance-dark")
                .build(app)?;
            let appearance_auto = MenuItemBuilder::new(ml("跟随系统", "システムに合わせる", "Auto"))
                .id("appearance-auto")
                .build(app)?;
            let appearance_submenu = SubmenuBuilder::new(app, ml("外观", "外観", "Appearance"))
                .item(&appearance_light)
                .item(&appearance_dark)
                .item(&appearance_auto)
                .build()?;

            let toggle_status_bar_item =
                CheckMenuItemBuilder::new(ml("显示状态栏", "ステータスバーを表示", "Show Status Bar"))
                    .id("toggle-status-bar")
                    .checked(show_status_bar)
                    .build(app)?;
            let navigation_mode_item = MenuItemBuilder::new(ml("导航模式", "ナビゲーションモード", "Navigation Mode"))
                .id("toggle-navigation-mode")
                .accelerator("CmdOrCtrl+B")
                .build(app)?;

            let view_menu = SubmenuBuilder::new(app, ml("视图", "表示", "View"))
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .separator()
                .item(&font_increase_item)
                .item(&font_decrease_item)
                .item(&font_reset_item)
                .separator()
                .item(&appearance_submenu)
                .separator()
                .item(&toggle_status_bar_item)
                .item(&navigation_mode_item)
                .build()?;

            // ── Window menu ───────────────────────────────────────────────
            let next_tab_item = MenuItemBuilder::new(ml("下一个标签页", "次のタブ", "Next Tab"))
                .id("next-tab")
                .accelerator("CmdOrCtrl+Shift+]")
                .build(app)?;
            let prev_tab_item = MenuItemBuilder::new(ml("上一个标签页", "前のタブ", "Previous Tab"))
                .id("prev-tab")
                .accelerator("CmdOrCtrl+Shift+[")
                .build(app)?;
            let move_tab_left_item = MenuItemBuilder::new(ml("向左移动标签页", "タブを左に移動", "Move Tab Left"))
                .id("move-tab-left")
                .accelerator("CmdOrCtrl+Shift+,")
                .build(app)?;
            let move_tab_right_item =
                MenuItemBuilder::new(ml("向右移动标签页", "タブを右に移動", "Move Tab Right"))
                    .id("move-tab-right")
                    .accelerator("CmdOrCtrl+Shift+.")
                    .build(app)?;
            let tab_color_item = MenuItemBuilder::new(ml("标签页颜色…", "タブの色…", "Tab Color…"))
                .id("pane-color")
                .build(app)?;

            let window_menu = SubmenuBuilder::new(app, ml("窗口", "ウィンドウ", "Window"))
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .separator()
                .item(&next_tab_item)
                .item(&prev_tab_item)
                .separator()
                .item(&move_tab_left_item)
                .item(&move_tab_right_item)
                .separator()
                .item(&tab_color_item)
                .build()?;

            // ── Help menu ─────────────────────────────────────────────────
            let keyboard_shortcuts_item =
                MenuItemBuilder::new(ml("键盘快捷键…", "キーボードショートカット…", "Keyboard Shortcuts…"))
                    .id("keyboard-shortcuts")
                    .accelerator("CmdOrCtrl+/")
                    .build(app)?;

            let help_menu = SubmenuBuilder::new(app, ml("帮助", "ヘルプ", "Help"))
                .item(&keyboard_shortcuts_item)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&ssh_menu)
                .item(&shell_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()?;
            app.set_menu(menu)?;

            // Enable ProMotion (up to 120 Hz) on the WKWebView layer so the
            // WebGL renderer and scroll animations run at the display's full
            // refresh rate on MacBook Pro / Studio Display.
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                let win2 = win.clone();
                let _ = win.run_on_main_thread(move || {
                    if let Ok(ptr) = win2.ns_window() {
                        settings::configure_promotion_frame_rate(ptr);
                    }
                });
            }

            // Inject "New Window" into the macOS Dock right-click menu.
            // setup() is called synchronously on the main thread (from
            // applicationDidFinishLaunching:), so we can call install() directly.
            #[cfg(target_os = "macos")]
            dock_menu::install(app.app_handle());

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().0 == "new-window" {
                let count = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
                let label = format!("window-{}", count);
                let _win = tauri::WebviewWindowBuilder::new(
                    app,
                    &label,
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Vibe99")
                .inner_size(1280.0, 800.0)
                .min_inner_size(600.0, 400.0)
                .build();
                return;
            }

            if event.id().0 == "settings" {
                if let Some(window) = focused_window(app) {
                    let _ = window.emit("open-settings", ());
                }
                return;
            }

            let action = event.id().0.clone();
            if let Some(window) = focused_window(app) {
                let _ = window.emit("vibe99:menu-action", MenuActionPayload {
                    action,
                    pane_id: None,
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_destroy,
            terminal::get_cwd,
            terminal::get_system_info,
            terminal::exit_app,
            settings::settings_load,
            settings::settings_save,
            settings::set_window_theme,
            shell_profile::shell_profiles_list,
            shell_profile::shell_profile_set,
            shell_profile::shell_profile_add,
            shell_profile::shell_profile_remove,
            shell_profile::shell_profiles_detect,
            ssh_config::read_ssh_config,
            context_menu::show_context_menu,
            context_menu::emit_menu_action,
            wsl_cmd::wsl_status,
            wsl_cmd::wsl_convert_path,
            wsl_cmd::wsl_cwd,
            shell_integration::install_shell_integration,
            notification::send_notification,
            new_window,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                // If this is the last window, destroy all terminals and exit the process.
                // Otherwise let it close naturally — remaining windows keep running.
                if window.webview_windows().len() <= 1 {
                    let state = window.state::<AppState>();
                    terminal::destroy_all_terminals(&state);
                    std::process::exit(0);
                }
            }
            // After every resize (including fullscreen entry/exit), re-apply
            // NSWindow.backgroundColor so the native area outside the WKWebView
            // CSS viewport is never black. This fires after windowDidEnterFullScreen:
            // completes — the correct moment to set the colour.
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                let is_light = vibe99_lib::IS_LIGHT_MODE.load(Ordering::Relaxed);
                let win = window.clone();
                // run_on_main_thread ensures the AppKit call is on the right thread.
                let _ = window.run_on_main_thread(move || {
                    if let Ok(ptr) = win.ns_window() {
                        vibe99_lib::commands::settings::set_ns_window_bg_ptr(ptr, is_light);
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
