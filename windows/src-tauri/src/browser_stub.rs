//! The in-app browser outside Windows. The real one (browser.rs) drives
//! WebView2 directly, so here every command answers "not supported" and the
//! UI hides the Browser tab. Claude's `browser_view` then gets the usual
//! "browser is not open" answer from the UI.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

const UNSUPPORTED: &str = "the in-app browser is only available on Windows";

/// A rectangle in logical (CSS) pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub type BrowserBounds = Rect;
pub type CaptureRect = Rect;

#[derive(Debug, Serialize)]
pub struct BrowserState {
    pub url: String,
}

#[derive(Default)]
pub struct Browser;

#[tauri::command]
pub async fn browser_open(_app: AppHandle, _state: State<'_, Browser>, _url: String, _bounds: BrowserBounds) -> Result<String, String> {
    Err(UNSUPPORTED.to_owned())
}

#[tauri::command]
pub async fn browser_navigate(_app: AppHandle, _url: String) -> Result<String, String> {
    Err(UNSUPPORTED.to_owned())
}

#[tauri::command]
pub async fn browser_set_bounds(_app: AppHandle, _bounds: BrowserBounds) -> Result<(), String> {
    Err(UNSUPPORTED.to_owned())
}

#[tauri::command]
pub async fn browser_set_visible(_app: AppHandle, _visible: bool) -> Result<(), String> {
    Err(UNSUPPORTED.to_owned())
}

#[tauri::command]
pub async fn browser_go(_app: AppHandle, _action: String) -> Result<(), String> {
    Err(UNSUPPORTED.to_owned())
}

#[tauri::command]
pub async fn browser_pick(_app: AppHandle, _state: State<'_, Browser>, _on: bool) -> Result<(), String> {
    Err(UNSUPPORTED.to_owned())
}

#[tauri::command]
pub async fn browser_state(_app: AppHandle) -> Option<BrowserState> {
    None
}

#[tauri::command]
pub async fn browser_capture(_app: AppHandle, _rect: Option<CaptureRect>) -> Result<String, String> {
    Err(UNSUPPORTED.to_owned())
}

#[tauri::command]
pub async fn browser_close(_app: AppHandle, _state: State<'_, Browser>) -> Result<(), String> {
    Ok(())
}
