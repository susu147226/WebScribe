pub mod commands;
pub mod document;
pub mod domain;
pub mod error;
pub mod logging;
pub mod merge;
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
        .setup(|app| {
            // 结构化日志写到应用数据目录下的 logs/
            use tauri::Manager;
            if let Ok(dir) = app.path().app_data_dir() {
                let state = app.state::<std::sync::Arc<commands::AppState>>();
                if let Err(e) = state.init_logger(&dir.join("logs")) {
                    // 日志不可用不应阻断启动，退化为 stderr
                    eprintln!("[WebScribe] 日志初始化失败：{e}");
                }

                // 把版本写进日志：排查问题时能立刻确认用户跑的是哪个构建
                state.log(
                    crate::logging::LogEntry::new("app-started")
                        .state(format!("WebScribe v{}", env!("CARGO_PKG_VERSION"))),
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::validate_urls,
            commands::environment_status,
            commands::start_crawl,
            commands::open_login,
            commands::clear_merge_records,
            commands::save_link_list,
            commands::load_link_list,
            commands::write_text_file,
            commands::read_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("WebScribe 启动失败");
}
