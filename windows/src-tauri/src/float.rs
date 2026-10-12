//! The floating buddy: a transparent window that hugs what it draws and stays
//! pinned by its bottom-right corner to a point on screen. The point starts
//! in the work area's corner and follows wherever the person drags the buddy.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalRect, WebviewWindow};

#[link(name = "user32")]
unsafe extern "system" {
    fn SetWindowPos(hwnd: isize, insert_after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
}

const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const MARGIN: f64 = 10.0;
const SAVE_EVERY: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

pub struct FloatState {
    anchor: Mutex<Option<Point>>,
    // The last size the page asked for, in logical pixels, to lay out again
    // after a reset without waiting for the page.
    size: Mutex<(f64, f64)>,
    // Where our own layout last put the window. A move to exactly there is
    // ours, not the person's: kept out of the anchor, or a window clamped at
    // a screen edge would drag the anchor along and the buddy would creep.
    laid: Mutex<Option<Point>>,
    saved_at: Mutex<Instant>,
    file: PathBuf,
}

impl FloatState {
    pub fn load(file: PathBuf) -> Self {
        let anchor = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|value| {
                let x = i32::try_from(value.get("x")?.as_i64()?).ok()?;
                let y = i32::try_from(value.get("y")?.as_i64()?).ok()?;

                Some(Point { x, y })
            });

        Self {
            anchor: Mutex::new(anchor),
            size: Mutex::new((0.0, 0.0)),
            laid: Mutex::new(None),
            saved_at: Mutex::new(Instant::now() - SAVE_EVERY),
            file,
        }
    }

    fn save(&self, anchor: Option<Point>) {
        let result = match anchor {
            Some(point) => std::fs::write(&self.file, serde_json::json!({ "x": point.x, "y": point.y }).to_string()),
            None => std::fs::remove_file(&self.file),
        };

        // A lost position only means the buddy starts in the corner again.
        drop(result);
    }
}

fn contains(area: &PhysicalRect<i32, u32>, point: Point) -> bool {
    let right = area.position.x + i32::try_from(area.size.width).unwrap_or(i32::MAX);
    let bottom = area.position.y + i32::try_from(area.size.height).unwrap_or(i32::MAX);

    point.x > area.position.x && point.x <= right && point.y > area.position.y && point.y <= bottom
}

/// Where the window goes for a size, keeping its bottom-right corner on the
/// anchor but never outside the work area that holds the anchor.
pub fn place(anchor: Point, width: i32, height: i32, area: &PhysicalRect<i32, u32>) -> Point {
    let left = area.position.x;
    let top = area.position.y;
    let right = left + i32::try_from(area.size.width).unwrap_or(i32::MAX);
    let bottom = top + i32::try_from(area.size.height).unwrap_or(i32::MAX);
    let x = (anchor.x - width).clamp(left, (right - width).max(left));
    let y = (anchor.y - height).clamp(top, (bottom - height).max(top));

    Point { x, y }
}

fn work_areas(window: &WebviewWindow) -> Vec<(PhysicalRect<i32, u32>, f64)> {
    window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| (*monitor.work_area(), monitor.scale_factor()))
        .collect()
}

fn default_anchor(window: &WebviewWindow) -> Option<(Point, PhysicalRect<i32, u32>, f64)> {
    let monitor = window.primary_monitor().ok().flatten()?;
    let area = *monitor.work_area();
    let scale = monitor.scale_factor();
    let margin = (MARGIN * scale).round() as i32;
    let right = area.position.x + i32::try_from(area.size.width).ok()?;
    let bottom = area.position.y + i32::try_from(area.size.height).ok()?;

    Some((Point { x: right - margin, y: bottom - margin }, area, scale))
}

/// Sizes the window to the page and moves it in one step, so nothing under
/// the cursor jumps (two separate moves made hover flicker).
pub fn layout(window: &WebviewWindow, state: &FloatState, width: f64, height: f64) -> Result<(), String> {
    *state.size.lock().map_err(|error| error.to_string())? = (width, height);

    let stored = *state.anchor.lock().map_err(|error| error.to_string())?;
    let areas = work_areas(window);
    let found = stored.and_then(|anchor| areas.iter().find(|(area, _)| contains(area, anchor)).map(|(area, scale)| (anchor, *area, *scale)));
    let (anchor, area, scale) = match found {
        Some(found) => found,
        None => default_anchor(window).ok_or("no monitor")?,
    };
    // Pixel sizes of a small window always fit in i32.
    let w = (width * scale).round().max(1.0) as i32;
    let h = (height * scale).round().max(1.0) as i32;
    let at = place(anchor, w, h, &area);
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;

    *state.laid.lock().map_err(|error| error.to_string())? = Some(at);

    // SAFETY: a valid top-level window handle from Tauri; flags keep z-order and focus as they are.
    let moved = unsafe { SetWindowPos(hwnd.0 as isize, 0, at.x, at.y, w, h, SWP_NOZORDER | SWP_NOACTIVATE) };

    if moved == 0 {
        return Err("SetWindowPos failed".to_owned());
    }

    Ok(())
}

/// Called when the window moved: by the person dragging it, or by our own
/// layout (which lands on the same anchor). Remembers the new corner.
pub fn moved(window: &WebviewWindow, state: &FloatState) {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };

    let laid = state.laid.lock().map(|laid| *laid).unwrap_or(None);

    if laid == Some(Point { x: position.x, y: position.y }) {
        return;
    }

    let anchor = Point {
        x: position.x + i32::try_from(size.width).unwrap_or(0),
        y: position.y + i32::try_from(size.height).unwrap_or(0),
    };
    let Ok(mut stored) = state.anchor.lock() else {
        return;
    };

    if *stored == Some(anchor) {
        return;
    }

    *stored = Some(anchor);

    if let Ok(mut saved_at) = state.saved_at.lock()
        && saved_at.elapsed() >= SAVE_EVERY
    {
        *saved_at = Instant::now();
        state.save(Some(anchor));
    }
}

pub fn flush(state: &FloatState) {
    if let Ok(stored) = state.anchor.lock() {
        state.save(*stored);
    }
}

/// Back to the corner of the main screen.
pub fn reset(app: &AppHandle) {
    let state = app.state::<FloatState>();

    if let Ok(mut stored) = state.anchor.lock() {
        *stored = None;
    }
    state.save(None);

    let size = state.size.lock().map(|size| *size).unwrap_or((0.0, 0.0));

    if let Some(window) = app.get_webview_window("float")
        && size.0 > 0.0
    {
        drop(layout(&window, &state, size.0, size.1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{PhysicalPosition, PhysicalSize};

    fn area() -> PhysicalRect<i32, u32> {
        PhysicalRect { position: PhysicalPosition::new(0, 0), size: PhysicalSize::new(1920, 1040) }
    }

    #[test]
    fn keeps_the_bottom_right_corner_on_the_anchor() {
        assert_eq!(place(Point { x: 1900, y: 1000 }, 300, 200, &area()), Point { x: 1600, y: 800 });
    }

    #[test]
    fn stays_inside_the_work_area_near_the_top_left() {
        assert_eq!(place(Point { x: 100, y: 60 }, 300, 200, &area()), Point { x: 0, y: 0 });
    }

    #[test]
    fn a_saved_position_survives_a_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("float.json");
        let state = FloatState::load(file.clone());

        state.save(Some(Point { x: 500, y: 700 }));
        assert_eq!(*FloatState::load(file).anchor.lock().unwrap(), Some(Point { x: 500, y: 700 }));
    }
}
