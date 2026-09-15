pub mod commands;
pub mod document;
pub mod domain;
pub mod error;
pub mod logging;
pub mod naming;
pub mod protocol;
pub mod save;
pub mod sidecar;
pub mod task;
pub mod url;

pub use error::{CrawlError, CrawlErrorKind, Result};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(std::sync::Arc::new(commands::AppState::default()))
        .invoke_handler(tauri::generate_handler![
            commands::validate_urls,
            commands::environment_status,
            commands::start_crawl,
            commands::open_login,
        ])
        .run(tauri::generate_context!())
        .expect("WebScribe 启动失败");
}
