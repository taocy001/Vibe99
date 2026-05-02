#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use vibe99_lib::commands::context_menu;
use vibe99_lib::commands::context_menu::MenuActionPayload;
use vibe99_lib::commands::settings;
use vibe99_lib::commands::settings::{get_saved_language, get_saved_is_light, get_saved_show_status_bar};
use vibe99_lib::commands::shell_integration;
use vibe99_lib::commands::shell_profile;
use vibe99_lib::commands::terminal::{self, AppState};
use vibe99_lib::commands::wsl as wsl_cmd;
use vibe99_lib::pty::PtyManager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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

            // ── Shell menu ────────────────────────────────────────────────
            let new_tab_item = MenuItemBuilder::new(ml("新建标签页", "新しいタブ", "New Tab"))
                .id("new-pane")
                .accelerator("CmdOrCtrl+N")
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

            let shell_menu = SubmenuBuilder::new(app, "Shell")
                .item(&new_tab_item)
                .item(&close_tab_item)
                .item(&close_window_item)
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
                .accelerator("CmdOrCtrl+Shift+N")
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
                .item(&shell_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().0 == "settings" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("open-settings", ());
                }
                return;
            }

            let action = event.id().0.clone();
            if let Some(window) = app.get_webview_window("main") {
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
            settings::settings_load,
            settings::settings_save,
            settings::set_window_theme,
            shell_profile::shell_profiles_list,
            shell_profile::shell_profile_set,
            shell_profile::shell_profile_add,
            shell_profile::shell_profile_remove,
            shell_profile::shell_profiles_detect,
            context_menu::show_context_menu,
            context_menu::emit_menu_action,
            wsl_cmd::wsl_status,
            wsl_cmd::wsl_convert_path,
            wsl_cmd::wsl_cwd,
            shell_integration::install_shell_integration,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<AppState>();
                terminal::destroy_all_terminals(&state);
                std::process::exit(0);
            }
            // After every resize (including fullscreen entry/exit), re-apply
            // NSWindow.backgroundColor so the native area outside the WKWebView
            // CSS viewport is never black. This fires after windowDidEnterFullScreen:
            // completes — the correct moment to set the colour.
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                use std::sync::atomic::Ordering;
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
