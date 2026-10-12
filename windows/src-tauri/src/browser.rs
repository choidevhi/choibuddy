//! The in-app browser: a native child webview (label `browser`) laid over the
//! rectangle the UI reserves in the main window, loading any site.
//!
//! It must never reach Tauri IPC. Tauri injects its IPC script into every
//! webview, so the protection is the ACL:
//! - a remote origin only passes with a capability that has a `remote`
//!   context, and there is none; `capabilities/default.json` also lists
//!   webviews instead of windows, so it does not cover this child of `main`;
//! - the app's own origins (`tauri.localhost`, and the dev server in dev
//!   builds) count as local, and app commands are not ACL-checked for local
//!   origins, so they are kept out of the browser as pages, as frames and as
//!   `tauri` protocol responses.
//!
//! The page reports a pick by navigating to `choibuddy-msg://<kind>?d=<json>`,
//! which `on_navigation` cancels and turns into an event for the main webview.

use std::borrow::Cow;
use std::io::Cursor;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::http::{Response, StatusCode};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PageLoadPayload, PlatformWebview, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl, Window};
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
use webview2_com::{CapturePreviewCompletedHandler, NavigationStartingEventHandler, SourceChangedEventHandler, take_pwstr};
use windows::Win32::Foundation::{HGLOBAL, HWND};
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos};
use windows::core::{PWSTR, w};

pub const LABEL: &str = "browser";
const MAIN: &str = "main";
const MESSAGE_SCHEME: &str = "choibuddy-msg";
const MAX_MESSAGE: usize = 64 * 1024;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const READ_CHUNK: u32 = 64 * 1024;
const NOT_OPEN: &str = "browser is not open";
const BLANK: &str = "about:blank";
// Hosts Tauri serves the app, its IPC and its assets from on Windows.
const APP_HOSTS: [&str; 3] = ["tauri.localhost", "ipc.localhost", "asset.localhost"];
const PICK_SCRIPT: &str = include_str!("browser_pick.js");
const PICK_ON: &str = "window.__choibuddyPick && window.__choibuddyPick(true)";
const PICK_OFF: &str = "window.__choibuddyPick && window.__choibuddyPick(false)";

/// A rectangle in logical (CSS) pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The page area, relative to the top-left of the main window's client area.
pub type BrowserBounds = Rect;

/// A part of the page viewport, relative to its top-left.
pub type CaptureRect = Rect;

#[derive(Debug, Serialize)]
pub struct BrowserState {
    pub url: String,
}

/// What the page script sends for a picked element (`browser-picked`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Picked {
    pub url: String,
    pub title: String,
    pub selector: String,
    pub tag: String,
    pub text: String,
    pub html: String,
    pub rect: Rect,
}

#[derive(Clone, Debug, Serialize)]
struct Navigated {
    url: String,
}

#[derive(Debug, PartialEq)]
pub enum PageMessage {
    Picked(Picked),
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    Block,
    Message,
}

#[derive(Default)]
pub struct Browser {
    // On from `browser_pick(true)` until the pick, a cancel or
    // `browser_pick(false)`; page messages outside it are dropped, so a page
    // cannot push a pick nobody asked for.
    picking: AtomicBool,
    // Two quick opens must not both try to add the child webview.
    creating: Mutex<()>,
}

/// Turns what was typed in the address bar into a URL to load. Searches,
/// bare words and every scheme but http(s) are refused; the UI searches.
pub fn normalize_url(input: &str) -> Result<Url, String> {
    let text = input.trim();

    if text.is_empty() {
        return Err("empty address".to_owned());
    }

    let lower = text.to_ascii_lowercase();

    if lower.starts_with("http://") || lower.starts_with("https://") {
        let url = Url::parse(text).map_err(|error| error.to_string())?;

        return match url.host_str() {
            Some(host) if !host.is_empty() => Ok(url),
            _ => Err("address has no host".to_owned()),
        };
    }

    if let Some(scheme) = scheme_of(text) {
        return Err(format!("{scheme}: addresses cannot be opened"));
    }

    let host = host_of(text);
    let looks_like_host = host.contains('.') || host == "localhost" || host.starts_with('[');

    if !looks_like_host || host.chars().any(char::is_whitespace) {
        return Err("not an address".to_owned());
    }

    let scheme = if is_local_host(&host) { "http" } else { "https" };

    Url::parse(&format!("{scheme}://{text}")).map_err(|error| error.to_string())
}

/// The scheme `text` starts with, if any. `host:port` is not a scheme, so
/// `localhost:5173` and `example.com:8080/x` stay addresses.
fn scheme_of(text: &str) -> Option<&str> {
    let (head, rest) = text.split_once(':')?;
    let mut chars = head.chars();
    let is_scheme = chars.next().is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));

    if !is_scheme {
        return None;
    }

    let port = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let is_port = !port.is_empty() && port.chars().all(|c| c.is_ascii_digit());
    let is_host = head.contains('.') || head.eq_ignore_ascii_case("localhost");

    if is_port && is_host { None } else { Some(head) }
}

/// The lowercased host of a scheme-less address, without user or port.
fn host_of(text: &str) -> String {
    let authority = text.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = if authority.starts_with('[') {
        authority.find(']').map_or(authority, |end| &authority[..=end])
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
            _ => authority,
        }
    };

    host.to_ascii_lowercase()
}

/// Loopback, private, link-local and tailnet addresses and local-only names
/// rarely have certificates, so they load over http.
fn is_local_host(host: &str) -> bool {
    if let Some(inside) = host.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
        return inside
            .parse::<Ipv6Addr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local());
    }

    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        // 100.x.y.z covers Tailscale's addresses.
        return ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || ip.octets()[0] == 100;
    }

    host == "localhost" || [".localhost", ".local", ".ts.net"].iter().any(|suffix| host.ends_with(suffix))
}

/// Documents Tauri would treat as the app itself: local origin, every app command.
fn is_app_origin(url: &Url, dev: Option<&Url>) -> bool {
    let app_host = url.host_str().is_some_and(|host| APP_HOSTS.contains(&host.trim_end_matches('.')));

    app_host || dev.is_some_and(|dev| dev.origin() == url.origin())
}

/// What to do with a top-level navigation in the browser.
pub fn classify(url: &Url, dev: Option<&Url>) -> Navigation {
    match url.scheme() {
        MESSAGE_SCHEME => Navigation::Message,
        "http" | "https" if !is_app_origin(url, dev) => Navigation::Allow,
        "about" if url.as_str() == BLANK => Navigation::Allow,
        // blob:https://site/uuid opens content the site made itself.
        "blob" => match Url::parse(url.path()) {
            Ok(inner) if matches!(inner.scheme(), "http" | "https") && !is_app_origin(&inner, dev) => Navigation::Allow,
            _ => Navigation::Block,
        },
        _ => Navigation::Block,
    }
}

/// Frames may load what any page can, except the app itself or a fake message.
fn frame_allowed(uri: &str, dev: Option<&Url>) -> bool {
    Url::parse(uri).map_or(true, |url| url.scheme() != MESSAGE_SCHEME && !is_app_origin(&url, dev))
}

/// Reads a `choibuddy-msg://<kind>?d=<json>` navigation made by the page script.
pub fn parse_message(url: &Url) -> Option<PageMessage> {
    if url.scheme() != MESSAGE_SCHEME || url.as_str().len() > MAX_MESSAGE {
        return None;
    }

    match url.host_str()? {
        "picked" => {
            let (_, data) = url.query_pairs().find(|(key, _)| key == "d")?;

            serde_json::from_str(&data).ok().map(PageMessage::Picked)
        }
        "cancel" => Some(PageMessage::Cancel),
        _ => None,
    }
}

/// A negative size from the UI means "nothing to show", not an error.
fn checked(bounds: Rect) -> Rect {
    Rect { width: bounds.width.max(0.0), height: bounds.height.max(0.0), ..bounds }
}

/// The device-pixel box `(x, y, width, height)` of a CSS-pixel `rect` in an
/// image of `width`×`height`, clamped to the image; `None` when none of it is inside.
pub fn crop_box(rect: Rect, scale: f64, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let edges = [rect.x * scale, rect.y * scale, (rect.x + rect.width) * scale, (rect.y + rect.height) * scale];

    if edges.iter().any(|edge| !edge.is_finite()) {
        return None;
    }

    // Clamped into 0..=max first, so the cast cannot overflow or wrap.
    let clamp = |value: f64, max: u32| value.clamp(0.0, f64::from(max)) as u32;
    let left = clamp(edges[0].floor(), width);
    let top = clamp(edges[1].floor(), height);
    let right = clamp(edges[2].ceil(), width);
    let bottom = clamp(edges[3].ceil(), height);

    (right > left && bottom > top).then(|| (left, top, right - left, bottom - top))
}

fn crop_png(png: &[u8], rect: Rect, scale: f64) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png).map_err(|error| error.to_string())?;
    let (x, y, width, height) = crop_box(rect, scale, image.width(), image.height()).ok_or("capture rectangle is outside the page")?;
    let mut out = Cursor::new(Vec::new());

    image
        .crop_imm(x, y, width, height)
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;

    Ok(out.into_inner())
}

/// Empties a `tauri` protocol response: the app's pages would run in the
/// browser with local IPC, so none of its files load there.
fn refuse(response: &mut Response<Cow<'static, [u8]>>) {
    *response.status_mut() = StatusCode::FORBIDDEN;
    response.headers_mut().clear();
    *response.body_mut() = Cow::Borrowed(&[]);
}

/// The dev server is the app only in dev builds.
fn dev_origin(app: &AppHandle) -> Option<Url> {
    if tauri::is_dev() { app.config().build.dev_url.clone() } else { None }
}

fn target(app: &AppHandle, input: &str) -> Result<Url, String> {
    let url = normalize_url(input)?;

    if is_app_origin(&url, dev_origin(app).as_ref()) {
        return Err("that address is the app itself".to_owned());
    }

    Ok(url)
}

/// WebView2 refuses a second environment with other browser arguments on the
/// same profile, so the browser takes the main window's.
fn main_browser_args(app: &AppHandle) -> Option<String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN)
        .and_then(|window| window.additional_browser_args.clone())
}

fn opened(app: &AppHandle) -> Result<Webview, String> {
    app.get_webview(LABEL).ok_or_else(|| NOT_OPEN.to_owned())
}

/// Emits from a task rather than inside the WebView2 callback that caused it,
/// so the event loop is never re-entered from there.
fn emit<S: Serialize + Clone + Send + 'static>(app: &AppHandle, event: &'static str, payload: S) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move { drop(app.emit_to(MAIN, event, payload)) });
}

fn emit_navigated(app: &AppHandle, url: String) {
    // The blank page the browser starts on is not somewhere the person went.
    if url != BLANK {
        emit(app, "browser-navigated", Navigated { url });
    }
}

fn deliver(app: &AppHandle, message: PageMessage) {
    if !app.state::<Browser>().picking.swap(false, Ordering::SeqCst) {
        return;
    }

    match message {
        PageMessage::Picked(picked) => emit(app, "browser-picked", picked),
        PageMessage::Cancel => emit(app, "browser-pick-cancel", ()),
    }
}

fn navigate_later(app: &AppHandle, url: Url) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        if let Some(webview) = app.get_webview(LABEL) {
            drop(webview.navigate(url));
        }
    });
}

fn loaded(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if !matches!(payload.event(), PageLoadEvent::Finished) {
        return;
    }

    // A new document starts with pick mode off; keep it on while the app wants it.
    if webview.state::<Browser>().picking.load(Ordering::SeqCst) {
        drop(webview.eval(PICK_ON));
    }

    emit_navigated(webview.app_handle(), payload.url().to_string());
}

/// Hooks two WebView2 events Tauri does not expose: frame navigations, to keep
/// the app's origins out of iframes, and URL changes, which also cover the
/// History API changes SPA routers make (`on_page_load` misses those). Reading
/// the URL from WebView2 means a page cannot report a fake one.
fn add_handlers(platform: &PlatformWebview, app: AppHandle, dev: Option<Url>) -> windows::core::Result<()> {
    // SAFETY: `with_webview` runs this on the main thread that owns the WebView2,
    // and its handlers are called back on that thread too.
    unsafe {
        let core = platform.controller().CoreWebView2()?;
        let mut token = 0_i64;
        let frames = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut uri = PWSTR::null();

            args.Uri(&mut uri)?;

            if !frame_allowed(&take_pwstr(uri), dev.as_ref()) {
                args.SetCancel(true)?;
            }

            Ok(())
        }));

        core.add_FrameNavigationStarting(&frames, &mut token)?;

        let sources = SourceChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(core) = sender else {
                return Ok(());
            };
            let mut uri = PWSTR::null();

            core.Source(&mut uri)?;
            emit_navigated(&app, take_pwstr(uri));

            Ok(())
        }));

        core.add_SourceChanged(&sources, &mut token)
    }
}

/// Tauri edge-resizes frameless windows through a child window kept on top
/// of the webviews; the browser is created above it, so put it back.
fn raise_resize_borders(window: &Window) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    // A raw handle is just a number; it crosses to the main thread as one.
    let parent = hwnd.0 as isize;

    drop(window.run_on_main_thread(move || {
        // SAFETY: called on the thread that owns the window; the flags keep
        // position, size and focus and only change the z-order.
        unsafe {
            let parent = HWND(parent as *mut std::ffi::c_void);

            if let Ok(borders) = FindWindowExW(Some(parent), None, w!("TAURI_DRAG_RESIZE_BORDERS"), w!("TAURI_DRAG_RESIZE_WINDOW")) {
                drop(SetWindowPos(borders, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE));
            }
        }
    }));
}

/// Adds the browser to the main window. It starts blank and navigates only
/// after the WebView2 hooks are in, so no frame of the first page slips past.
fn create(app: &AppHandle, bounds: Rect) -> Result<Webview, String> {
    let window = app.get_window(MAIN).ok_or("main window is missing")?;
    let dev = dev_origin(app);
    let navigation_app = app.clone();
    let navigation_dev = dev.clone();
    let popup_app = app.clone();
    let popup_dev = dev.clone();
    let blank = Url::parse(BLANK).map_err(|error| error.to_string())?;
    let mut builder = WebviewBuilder::new(LABEL, WebviewUrl::External(blank))
        .initialization_script(PICK_SCRIPT)
        .focused(false)
        .on_navigation(move |url| match classify(url, navigation_dev.as_ref()) {
            Navigation::Allow => true,
            Navigation::Block => false,
            Navigation::Message => {
                if let Some(message) = parse_message(url) {
                    deliver(&navigation_app, message);
                }

                false
            }
        })
        // Links and window.open load here instead; a stray popup window would
        // sit outside the app and outside these checks.
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") && classify(&url, popup_dev.as_ref()) == Navigation::Allow {
                navigate_later(&popup_app, url);
            }

            NewWindowResponse::Deny
        })
        .on_page_load(|webview, payload| loaded(&webview, &payload))
        .on_web_resource_request(|_request, response| refuse(response));

    if let Some(args) = main_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }

    let webview = window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| error.to_string())?;
    let hooks_app = app.clone();

    webview
        .with_webview(move |platform| {
            if let Err(error) = add_handlers(&platform, hooks_app, dev) {
                eprintln!("browser: WebView2 hooks failed: {error}");
            }
        })
        .map_err(|error| error.to_string())?;
    raise_resize_borders(&window);

    Ok(webview)
}

fn place(webview: &Webview, bounds: Rect) -> Result<(), String> {
    let bounds = checked(bounds);

    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|error| error.to_string())
}

fn start_capture(platform: &PlatformWebview, done: Sender<Result<Vec<u8>, String>>) {
    let failed = done.clone();
    // SAFETY: `with_webview` runs this on the main thread that owns the WebView2;
    // the handler keeps the stream alive until the capture completes.
    let started = unsafe {
        platform.controller().CoreWebView2().and_then(|core| {
            let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
            let reader = stream.clone();
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                drop(done.send(result.and_then(|()| read_stream(&reader)).map_err(|error| error.to_string())));

                Ok(())
            }));

            core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
        })
    };

    if let Err(error) = started {
        drop(failed.send(Err(error.to_string())));
    }
}

fn read_stream(stream: &IStream) -> windows::core::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = vec![0_u8; READ_CHUNK as usize];

    // SAFETY: every read goes into `chunk`, never past its length.
    unsafe {
        stream.Seek(0, STREAM_SEEK_SET, None)?;

        loop {
            let mut read = 0_u32;

            stream.Read(chunk.as_mut_ptr().cast(), READ_CHUNK, Some(&raw mut read)).ok()?;

            if read == 0 {
                break;
            }

            bytes.extend_from_slice(&chunk[..read as usize]);
        }
    }

    Ok(bytes)
}

/// The visible page as PNG bytes, at device pixels.
async fn capture_png(webview: &Webview) -> Result<Vec<u8>, String> {
    let (done, result) = mpsc::channel();

    webview
        .with_webview(move |platform| start_capture(&platform, done))
        .map_err(|error| error.to_string())?;

    tauri::async_runtime::spawn_blocking(move || result.recv_timeout(CAPTURE_TIMEOUT))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "capture timed out".to_owned())?
}

// Commands are async: on Windows, adding a webview from a synchronous command
// deadlocks (wry#583), and the rest stay off the main thread they wait on.

#[tauri::command]
pub async fn browser_open(app: AppHandle, state: State<'_, Browser>, url: String, bounds: BrowserBounds) -> Result<String, String> {
    let url = target(&app, &url)?;
    let _creating = state.creating.lock().map_err(|error| error.to_string())?;
    let webview = match app.get_webview(LABEL) {
        Some(webview) => webview,
        None => create(&app, checked(bounds))?,
    };

    place(&webview, bounds)?;
    webview.navigate(url.clone()).map_err(|error| error.to_string())?;
    webview.show().map_err(|error| error.to_string())?;

    Ok(url.to_string())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, url: String) -> Result<String, String> {
    let url = target(&app, &url)?;

    opened(&app)?.navigate(url.clone()).map_err(|error| error.to_string())?;

    Ok(url.to_string())
}

#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, bounds: BrowserBounds) -> Result<(), String> {
    place(&opened(&app)?, bounds)
}

/// Hides without destroying, so the page keeps its state behind another tab or a modal.
#[tauri::command]
pub async fn browser_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let webview = opened(&app)?;
    let result = if visible { webview.show() } else { webview.hide() };

    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_go(app: AppHandle, action: String) -> Result<(), String> {
    let webview = opened(&app)?;
    let result = match action.as_str() {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.reload(),
        _ => return Err(format!("unknown action: {action}")),
    };

    result.map_err(|error| error.to_string())
}

/// Pick mode also focuses the page, so Escape there can cancel it.
#[tauri::command]
pub async fn browser_pick(app: AppHandle, state: State<'_, Browser>, on: bool) -> Result<(), String> {
    let webview = opened(&app)?;

    state.picking.store(on, Ordering::SeqCst);
    webview.eval(if on { PICK_ON } else { PICK_OFF }).map_err(|error| error.to_string())?;

    if on {
        webview.set_focus().map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn browser_state(app: AppHandle) -> Option<BrowserState> {
    let webview = app.get_webview(LABEL)?;
    let url = webview.url().map(|url| url.to_string()).unwrap_or_default();

    Some(BrowserState { url })
}

#[tauri::command]
pub async fn browser_capture(app: AppHandle, rect: Option<CaptureRect>) -> Result<String, String> {
    let webview = opened(&app)?;
    let png = capture_png(&webview).await?;
    let png = match rect {
        Some(rect) => {
            let scale = webview.window().scale_factor().map_err(|error| error.to_string())?;

            crop_png(&png, rect, scale)?
        }
        None => png,
    };

    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, state: State<'_, Browser>) -> Result<(), String> {
    state.picking.store(false, Ordering::SeqCst);

    match app.get_webview(LABEL) {
        Some(webview) => webview.close().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    fn normalized(input: &str) -> String {
        normalize_url(input).unwrap().to_string()
    }

    fn picked() -> Picked {
        Picked {
            url: "https://example.com/a".to_owned(),
            title: "예제 & \"quotes\"".to_owned(),
            selector: "#main > div.card:nth-of-type(2)".to_owned(),
            tag: "div".to_owned(),
            text: "Hello 100% world".to_owned(),
            html: "<div class=\"card\">Hello</div>".to_owned(),
            rect: Rect { x: 1.5, y: 2.0, width: 300.0, height: 40.25 },
        }
    }

    // What JavaScript's encodeURIComponent does.
    fn encode_uri_component(text: &str) -> String {
        text.bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                    char::from(byte).to_string()
                }
                _ => format!("%{byte:02X}"),
            })
            .collect()
    }

    // Built the way the page script builds it.
    fn message(kind: &str, data: &str) -> Url {
        url(&format!("choibuddy-msg://{kind}?d={}", encode_uri_component(data)))
    }

    #[test]
    fn local_addresses_load_over_http() {
        assert_eq!(normalized("localhost:5173"), "http://localhost:5173/");
        assert_eq!(normalized("127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
        assert_eq!(normalized("100.101.102.103:3000"), "http://100.101.102.103:3000/");
        assert_eq!(normalized("192.168.0.7"), "http://192.168.0.7/");
        assert_eq!(normalized("10.1.2.3/admin"), "http://10.1.2.3/admin");
        assert_eq!(normalized("printer.local"), "http://printer.local/");
        assert_eq!(normalized("box.tail1234.ts.net:8443/x?y=1"), "http://box.tail1234.ts.net:8443/x?y=1");
        assert_eq!(normalized("[::1]:8080"), "http://[::1]:8080/");
    }

    #[test]
    fn other_addresses_load_over_https_and_explicit_schemes_stay() {
        assert_eq!(normalized("example.com"), "https://example.com/");
        assert_eq!(normalized("  docs.rs/tauri  "), "https://docs.rs/tauri");
        assert_eq!(normalized("example.com:8080/x"), "https://example.com:8080/x");
        assert_eq!(normalized("http://example.com"), "http://example.com/");
        assert_eq!(normalized("HTTPS://Example.com/Path"), "https://example.com/Path");
        assert_eq!(normalized("https://localhost:5173/a"), "https://localhost:5173/a");
    }

    #[test]
    fn searches_and_other_schemes_are_refused() {
        for input in [
            "",
            "   ",
            "how to cook rice",
            "rust",
            "how to cook rice.com",
            "javascript:alert(1)",
            "javascript:1",
            "JavaScript:alert(1)",
            "file:///C:/Windows/win.ini",
            "data:text/html,<b>x</b>",
            "chrome://settings",
            "edge://flags",
            "about:blank",
            "view-source:https://example.com",
            "mailto:me@example.com",
            "ftp://example.com",
            "https://",
        ] {
            assert!(normalize_url(input).is_err(), "{input:?} should be refused");
        }
    }

    #[test]
    fn the_app_itself_never_loads_in_the_browser() {
        let dev = url("http://localhost:1430/");

        assert_eq!(classify(&url("http://tauri.localhost/index.html"), None), Navigation::Block);
        assert_eq!(classify(&url("https://TAURI.localhost./"), None), Navigation::Block);
        assert_eq!(classify(&url("http://ipc.localhost/connection"), None), Navigation::Block);
        assert_eq!(classify(&url("http://localhost:1430/?view=float"), Some(&dev)), Navigation::Block);
        assert_eq!(classify(&url("blob:http://tauri.localhost/1234"), None), Navigation::Block);
        assert!(!frame_allowed("http://tauri.localhost/", None));
        assert!(!frame_allowed("http://localhost:1430/", Some(&dev)));
        assert!(!frame_allowed("choibuddy-msg://picked?d=%7B%7D", None));
        assert!(frame_allowed("https://www.youtube.com/embed/x", Some(&dev)));
        assert!(frame_allowed("about:srcdoc", None));
    }

    #[test]
    fn web_pages_load_and_messages_are_intercepted() {
        let dev = url("http://localhost:1430/");

        assert_eq!(classify(&url("https://example.com/"), Some(&dev)), Navigation::Allow);
        assert_eq!(classify(&url("http://localhost:5173/"), Some(&dev)), Navigation::Allow);
        assert_eq!(classify(&url("about:blank"), None), Navigation::Allow);
        assert_eq!(classify(&url("blob:https://example.com/1234"), None), Navigation::Allow);
        assert_eq!(classify(&url("choibuddy-msg://cancel?d=%7B%7D"), None), Navigation::Message);
        assert_eq!(classify(&url("file:///C:/x"), None), Navigation::Block);
        assert_eq!(classify(&url("ms-settings:privacy"), None), Navigation::Block);
        assert_eq!(classify(&url("about:settings"), None), Navigation::Block);
    }

    #[test]
    fn a_picked_message_round_trips() {
        let data = serde_json::to_string(&picked()).unwrap();

        assert_eq!(parse_message(&message("picked", &data)), Some(PageMessage::Picked(picked())));
        assert_eq!(parse_message(&message("cancel", "{}")), Some(PageMessage::Cancel));
    }

    // Produced by browser_pick.js in headless Edge (the WebView2 engine); only
    // the page URL was shortened. Covers Korean, an emoji, quotes, & and %.
    #[test]
    fn a_message_from_the_page_script_parses() {
        let sample = "choibuddy-msg://picked?d=%7B%22url%22%3A%22https%3A%2F%2Fexample.com%2Fa%22%2C%22title%22%3A%22%ED%85%8C%EC%8A%A4%ED%8A%B8%20%5C%22%ED%8E%98%EC%9D%B4%EC%A7%80%5C%22%22%2C%22selector%22%3A%22%23main%20%3E%20section.cards%20%3E%20div.card.b%3Anth-of-type(2)%22%2C%22tag%22%3A%22div%22%2C%22text%22%3A%22%EB%91%90%20%EB%B2%88%EC%A7%B8%20%EC%B9%B4%EB%93%9C%20%5C%22%EB%94%B0%EC%98%B4%ED%91%9C%5C%22%20%26%20100%25%20%F0%9F%98%80%22%2C%22html%22%3A%22%3Cdiv%20class%3D%5C%22card%20b%5C%22%3E%EB%91%90%20%EB%B2%88%EC%A7%B8%20%EC%B9%B4%EB%93%9C%20%5C%22%EB%94%B0%EC%98%B4%ED%91%9C%5C%22%20%26amp%3B%20100%25%20%F0%9F%98%80%3C%2Fdiv%3E%22%2C%22rect%22%3A%7B%22x%22%3A8%2C%22y%22%3A32%2C%22width%22%3A740%2C%22height%22%3A24%7D%7D";
        let expected = Picked {
            url: "https://example.com/a".to_owned(),
            title: "테스트 \"페이지\"".to_owned(),
            selector: "#main > section.cards > div.card.b:nth-of-type(2)".to_owned(),
            tag: "div".to_owned(),
            text: "두 번째 카드 \"따옴표\" & 100% 😀".to_owned(),
            html: "<div class=\"card b\">두 번째 카드 \"따옴표\" &amp; 100% 😀</div>".to_owned(),
            rect: Rect { x: 8.0, y: 32.0, width: 740.0, height: 24.0 },
        };

        assert_eq!(classify(&url(sample), None), Navigation::Message);
        assert_eq!(parse_message(&url(sample)), Some(PageMessage::Picked(expected)));
    }

    #[test]
    fn foreign_or_broken_messages_are_ignored() {
        let data = serde_json::to_string(&picked()).unwrap();
        let encoded = encode_uri_component(&data);

        assert_eq!(parse_message(&url(&format!("https://picked/?d={encoded}"))), None);
        assert_eq!(parse_message(&url(&format!("choibuddy-other://picked?d={encoded}"))), None);
        assert_eq!(parse_message(&message("unknown", &data)), None);
        assert_eq!(parse_message(&message("picked", "{not json")), None);
        assert_eq!(parse_message(&message("picked", r#"{"url":"https://example.com"}"#)), None);
        assert_eq!(parse_message(&url("choibuddy-msg://picked")), None);
    }

    #[test]
    fn oversized_messages_are_ignored() {
        let mut big = picked();

        big.html = "가".repeat(MAX_MESSAGE);

        let data = serde_json::to_string(&big).unwrap();

        assert_eq!(parse_message(&message("picked", &data)), None);
    }

    #[test]
    fn negative_sizes_become_empty() {
        let bounds = checked(Rect { x: -4.0, y: 10.0, width: -1.0, height: 20.0 });

        assert_eq!(bounds, Rect { x: -4.0, y: 10.0, width: 0.0, height: 20.0 });
    }

    #[test]
    fn crop_boxes_scale_and_clamp_to_the_image() {
        let rect = Rect { x: 10.0, y: 20.0, width: 100.0, height: 50.0 };

        assert_eq!(crop_box(rect, 1.0, 800, 600), Some((10, 20, 100, 50)));
        assert_eq!(crop_box(rect, 1.25, 800, 600), Some((12, 25, 126, 63)));
        assert_eq!(crop_box(Rect { x: -20.0, y: 580.0, width: 100.0, height: 100.0 }, 1.0, 800, 600), Some((0, 580, 80, 20)));
        assert_eq!(crop_box(Rect { x: 900.0, y: 0.0, width: 10.0, height: 10.0 }, 1.0, 800, 600), None);
        assert_eq!(crop_box(Rect { x: 0.0, y: 0.0, width: 0.0, height: 10.0 }, 1.0, 800, 600), None);
        assert_eq!(crop_box(Rect { x: f64::NAN, ..rect }, 1.0, 800, 600), None);
    }

    #[test]
    fn a_capture_is_cropped_in_device_pixels() {
        let mut png = Cursor::new(Vec::new());

        image::DynamicImage::new_rgba8(200, 100).write_to(&mut png, image::ImageFormat::Png).unwrap();

        let cropped = crop_png(png.get_ref(), Rect { x: 10.0, y: 5.0, width: 30.0, height: 20.0 }, 2.0).unwrap();
        let image = image::load_from_memory_with_format(&cropped, image::ImageFormat::Png).unwrap();

        assert_eq!((image.width(), image.height()), (60, 40));
        assert!(crop_png(png.get_ref(), Rect { x: 500.0, y: 0.0, width: 10.0, height: 10.0 }, 2.0).is_err());
    }

    #[test]
    fn app_files_are_refused_inside_the_browser() {
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "text/html")
            .body(Cow::Borrowed(&b"<html>app</html>"[..]))
            .unwrap();

        refuse(&mut response);

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.headers().is_empty());
        assert!(response.body().is_empty());
    }
}
