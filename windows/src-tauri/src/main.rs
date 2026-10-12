// 릴리스에서는 콘솔 창을 띄우지 않는다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    choibuddy_lib::run()
}
