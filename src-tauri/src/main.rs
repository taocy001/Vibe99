#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use vibe99_lib::commands::context_menu;
use vibe99_lib::commands::context_menu::MenuActionPayload;
use vibe99_lib::commands::settings;
use vibe99_lib::commands::settings::get_saved_language;
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
            let lang = get_saved_language(app.app_handle());
            let l = lang.as_str();

            // Helper: pick text by locale
            let ml = |zh: &'static str, ja: &'static str, en: &'static str| -> &'static str {
                if l.starts_with("zh") { zh } else if l == "ja" { ja } else { en }
            };

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

            let new_pane_item = MenuItemBuilder::new(ml("新建面板", "新しいペイン", "New Pane"))
                .id("new-pane")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let close_pane_item = MenuItemBuilder::new(ml("关闭面板", "ペインを閉じる", "Close Pane"))
                .id("close-pane")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let broadcast_item = CheckMenuItemBuilder::new(ml("广播输入", "入力を一斉送信", "Broadcast Input"))
                .id("broadcast-toggle")
                .accelerator("CmdOrCtrl+Shift+B")
                .checked(false)
                .build(app)?;

            let shell_menu = SubmenuBuilder::new(app, "Shell")
                .item(&new_pane_item)
                .item(&close_pane_item)
                .separator()
                .item(&broadcast_item)
                .build()?;

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

            let view_menu_label = ml("视图", "表示", "View");
            let view_menu = SubmenuBuilder::new(app, view_menu_label)
                .item(&font_increase_item)
                .item(&font_decrease_item)
                .item(&font_reset_item)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&shell_menu)
                .item(&view_menu)
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
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
