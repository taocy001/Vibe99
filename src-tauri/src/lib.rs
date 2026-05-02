pub mod commands;
pub mod pty;
pub mod wsl;

/// Tracks whether the app is currently in light mode.
/// Written by set_window_theme; read by the on_window_event resize handler.
pub static IS_LIGHT_MODE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
