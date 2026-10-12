mod bridge;
mod browser;
mod float;

use float::FloatState;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, Window, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::StateFlags;

// The main window is a plain `Window`, not a `WebviewWindow`: once the browser
// is added as a second webview, Tauri stops treating it as a webview window
// (`get_webview_window` returns None and `WebviewWindow` arguments fail).
fn main_window(app: &AppHandle) -> Option<Window> {
    app.get_window("main")
}

fn show(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show(app);
        }
    }
}

#[tauri::command]
fn connection() -> String {
    bridge::connection_json(&bridge::home())
}

#[tauri::command]
async fn start_bridge() -> bool {
    tauri::async_runtime::spawn_blocking(|| bridge::ensure(&bridge::home())).await.unwrap_or(false)
}

#[tauri::command]
async fn install_bridge(app: AppHandle) -> bool {
    let Ok(resources) = app.path().resource_dir() else {
        return false;
    };

    tauri::async_runtime::spawn_blocking(move || bridge::install(&resources) && bridge::ensure(&bridge::home()))
        .await
        .unwrap_or(false)
}

#[tauri::command]
fn set_always_on_top(window: Window, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_window(window: Window) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn minimize_window(window: Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

/// Brings the widget back for an approval request without stealing focus
/// from whatever the person is typing in.
#[tauri::command]
fn reveal_window(window: Window) -> Result<(), String> {
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())
}

#[tauri::command]
fn show_main(app: AppHandle) {
    show(&app);
}

#[tauri::command]
fn set_float(app: AppHandle, on: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("float") else {
        return Ok(());
    };
    let result = if on { window.show() } else { window.hide() };

    result.map_err(|error| error.to_string())
}

/// Sizes the floating buddy to what it draws, keeping it where it was put.
#[tauri::command]
fn float_layout(window: WebviewWindow, state: State<'_, FloatState>, width: f64, height: f64) -> Result<(), String> {
    float::layout(&window, &state, width, height)
}

#[tauri::command]
fn reset_float(app: AppHandle) {
    float::reset(&app);
}

struct TrayItems {
    open: MenuItem<Wry>,
    float: MenuItem<Wry>,
    reset: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

/// The tray menu follows the language picked in the app.
#[tauri::command]
fn set_tray_texts(items: State<'_, TrayItems>, open: String, float: String, reset: String, quit: String) -> Result<(), String> {
    items.open.set_text(open).map_err(|error| error.to_string())?;
    items.float.set_text(float).map_err(|error| error.to_string())?;
    items.reset.set_text(reset).map_err(|error| error.to_string())?;
    items.quit.set_text(quit).map_err(|error| error.to_string())
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if on { launcher.enable() } else { launcher.disable() };

    result.map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                // The floating buddy keeps its own anchor (float.rs).
                .with_denylist(&["float"])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            connection,
            start_bridge,
            install_bridge,
            set_always_on_top,
            hide_window,
            minimize_window,
            reveal_window,
            show_main,
            set_float,
            float_layout,
            reset_float,
            set_tray_texts,
            autostart_enabled,
            set_autostart,
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_go,
            browser::browser_pick,
            browser::browser_state,
            browser::browser_capture,
            browser::browser_close,
        ])
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;

            std::fs::create_dir_all(&config_dir)?;
            app.manage(FloatState::load(config_dir.join("float.json")));
            app.manage(browser::Browser::default());

            // Multi-webview mode builds every window's webview as a child,
            // which skips Tauri's edge-resize handler for frameless windows;
            // setting resizable again attaches it.
            if let Some(window) = main_window(app.handle()) {
                window.set_resizable(true)?;
            }

            let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
            let float_on = MenuItem::with_id(app, "show_float", "플로팅 버디 켜기", true, None::<&str>)?;
            let reset = MenuItem::with_id(app, "reset_float", "버디 위치 초기화", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &float_on, &reset, &quit])?;

            app.manage(TrayItems { open: open.clone(), float: float_on.clone(), reset: reset.clone(), quit: quit.clone() });
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("ChoiBuddy")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    // The buddy turned itself off; the app's setting follows this event.
                    "show_float" => {
                        let _ = set_float(app.clone(), true);
                        let _ = app.emit_to("main", "tray-float-on", ());
                    }
                    "reset_float" => float::reset(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray.build(app)?;

            // Started by Windows at sign-in: stay in the tray, keep the bridge up.
            if !std::env::args().any(|arg| arg == "--hidden") {
                show(app.handle());
            }

            std::thread::spawn(|| bridge::ensure(&bridge::home()));

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // The close button hides to the tray; "종료" in the tray menu quits.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Moved(_) if window.label() == "float" => {
                if let Some(float_window) = window.app_handle().get_webview_window("float") {
                    float::moved(&float_window, &window.app_handle().state::<FloatState>());
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("ChoiBuddy를 시작하지 못했습니다")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                float::flush(&app.state::<FloatState>());
            }
        });
}
