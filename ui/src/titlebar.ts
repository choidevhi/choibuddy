import { invoke } from '@tauri-apps/api/core'

// macOS: a double click on the top bar never maximized. Tauri starts the
// window drag on the first mousedown, and macOS's drag loop takes the clicks
// that follow, so the page never sees a second click (detail 2). Here the
// drag still starts at once, and a second press soon after, on the same spot,
// zooms the window instead. Runs before Tauri's own drag handler (capture on
// window), which it then stops.

// About macOS's default double-click interval.
const DOUBLE_MS = 500
const SLOP_PX = 4

const CLICKABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY'])
const ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option'])

function clickable(element: HTMLElement): boolean {
  const editable = element.getAttribute('contenteditable')
  const tabindex = element.getAttribute('tabindex')

  return CLICKABLE.has(element.tagName) || (editable !== null && editable !== 'false') || (tabindex !== null && tabindex !== '-1') || ROLES.has(element.getAttribute('role') ?? '')
}

// Tauri's rule for data-tauri-drag-region: a bare value counts only on the
// element itself, "deep" for its whole subtree, "false" blocks; a clickable
// element in between blocks too.
export function inDragRegion(path: EventTarget[]): boolean {
  for (const target of path) {
    if (!(target instanceof HTMLElement)) continue

    const value = target.getAttribute('data-tauri-drag-region')

    if (value === null && clickable(target)) return false
    if (value === null) continue
    if (value === 'false') return false
    if (value === 'deep') return true

    return target === path[0]
  }

  return false
}

export function installMacTitleBar(): void {
  let lastAt = 0
  let lastX = 0
  let lastY = 0

  window.addEventListener(
    'mousedown',
    event => {
      if (event.button !== 0 || !inDragRegion(event.composedPath())) return

      event.preventDefault()
      event.stopImmediatePropagation()

      const again = event.timeStamp - lastAt < DOUBLE_MS && Math.abs(event.screenX - lastX) <= SLOP_PX && Math.abs(event.screenY - lastY) <= SLOP_PX

      lastAt = again ? 0 : event.timeStamp
      lastX = event.screenX
      lastY = event.screenY
      void invoke(again ? 'plugin:window|internal_toggle_maximize' : 'plugin:window|start_dragging').catch(() => undefined)
    },
    true,
  )
}
