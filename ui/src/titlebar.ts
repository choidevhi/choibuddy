import { invoke } from '@tauri-apps/api/core'
import { inDragRegion } from './drag-region.ts'

// macOS: a double click on the top bar never maximized. Tauri starts the
// window drag on the first mousedown; that request reaches the window a
// moment later, and macOS's drag loop then takes the clicks after it, so the
// page never saw the second click. Here a press only arms the drag: it starts
// once the pointer moves with the button held, and a second press soon after,
// on the same spot, zooms the window instead (toggle_zoom: Tauri's own
// toggle does nothing for a frameless window on macOS). Runs before Tauri's
// own drag handler (capture on window), which it then stops.

// About macOS's default double-click interval.
const DOUBLE_MS = 500
const SLOP_PX = 4

export function installMacTitleBar(): void {
  let lastAt = 0
  let lastX = 0
  let lastY = 0
  let armed = false

  window.addEventListener(
    'mousedown',
    event => {
      if (event.button !== 0 || !inDragRegion(event.composedPath().map(target => (target instanceof HTMLElement ? target : null)))) return

      event.preventDefault()
      event.stopImmediatePropagation()

      const again = event.timeStamp - lastAt < DOUBLE_MS && Math.abs(event.screenX - lastX) <= SLOP_PX && Math.abs(event.screenY - lastY) <= SLOP_PX

      lastAt = again ? 0 : event.timeStamp
      lastX = event.screenX
      lastY = event.screenY
      armed = !again
      if (again) void invoke('toggle_zoom').catch(() => undefined)
    },
    true,
  )

  window.addEventListener(
    'mousemove',
    event => {
      if (!armed) return
      if ((event.buttons & 1) === 0) {
        armed = false

        return
      }
      if (Math.abs(event.screenX - lastX) <= SLOP_PX && Math.abs(event.screenY - lastY) <= SLOP_PX) return

      armed = false
      lastAt = 0
      void invoke('plugin:window|start_dragging').catch(() => undefined)
    },
    true,
  )

  window.addEventListener('mouseup', () => {
    armed = false
  }, true)
}
