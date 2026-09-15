// 发布版在 Windows 上不弹出额外的控制台窗口，请勿移除
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    webscribe_lib::run()
}
