import { useEffect, useRef, useSyncExternalStore } from 'react'

// What the phone's back button closes, newest last: a sheet, the picture
// viewer, a menu, an open document. App asks here first and only then goes
// back through the tabs.
const layers: Array<{ close: () => void }> = []

// Sheets, menus and viewers over the window, counted for the browser: its
// page is a native view no web content can cover, so it steps aside.
let overlays = 0
const listeners = new Set<() => void>()

function changeOverlays(by: number): void {
  overlays += by

  for (const listener of listeners) listener()
}

// While `open`, the back button runs `close` (the one from the latest render).
// `overlay` is false for a layer drawn in place, not over the window.
export function useBackLayer(open: boolean, close: () => void, overlay = true): void {
  const latest = useRef(close)

  useEffect(() => {
    latest.current = close
  })

  useEffect(() => {
    if (!open) return

    const layer = { close: () => latest.current() }

    layers.push(layer)
    if (overlay) changeOverlays(1)

    return () => {
      const index = layers.indexOf(layer)

      if (index !== -1) layers.splice(index, 1)
      if (overlay) changeOverlays(-1)
    }
  }, [open])
}

// Closes the newest layer; false when nothing is open.
export function closeTopLayer(): boolean {
  const top = layers.at(-1)

  if (top === undefined) return false

  top.close()

  return true
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

// Whether something is drawn over the window right now.
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, () => overlays > 0)
}
