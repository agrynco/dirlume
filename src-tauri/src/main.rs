#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(status) = dirlume_lib::environment::helper() {
        std::process::exit(status);
    }
    dirlume_lib::run();
}
