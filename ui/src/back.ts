import { useEffect, useRef } from 'react'

// What the phone's back button closes, newest last: a sheet, the picture
// viewer, a menu, an open document. App asks here first and only then goes
// back through the tabs.
const layers: Array<{ close: () => void }> = []

// While `open`, the back button runs `close` (the one from the latest render).
export function useBackLayer(open: boolean, close: () => void): void {
  const latest = useRef(close)

  useEffect(() => {
    latest.current = close
  })

  useEffect(() => {
    if (!open) return

    const layer = { close: () => latest.current() }

    layers.push(layer)

    return () => {
      const index = layers.indexOf(layer)

      if (index !== -1) layers.splice(index, 1)
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
