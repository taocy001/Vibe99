#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use vibe99_lib::commands::context_menu;
use vibe99_lib::commands::settings;
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
            let settings_item = MenuItemBuilder::new("Settings...")
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

            let menu = MenuBuilder::new(app).item(&app_menu).build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().0 == "settings" {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("open-settings", ());
                }
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
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                terminal::destroy_all_terminals(&state);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
