// Windows desktop previews must use the GUI subsystem in both debug and
// release builds. A console-subsystem debug binary spawns a blank terminal
// window alongside the Tauri WebView when launched from Explorer.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    chatgpt2codex_desktop_lib::run();
}
