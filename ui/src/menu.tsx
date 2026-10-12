import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useBackLayer } from './back.ts'

export type MenuEntry = {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  // Says why an item can't be used, under its label.
  hint?: string
}

type Props = {
  // Where the right click (or long press) was.
  at: { x: number; y: number }
  // Shown at the top of the sheet on a phone.
  title: string
  // A null starts a new group under a thin line.
  items: Array<MenuEntry | null>
  onClose: () => void
}

const SHEET_BELOW_PX = 560
const EDGE_PX = 8

// The app's own right-click menu: the WebView's (Back, Save as…, Print)
// means nothing here. A popover at the pointer on a PC, a sheet from the
// bottom on a phone, like the pickers.
export function ContextMenu({ at, title, items, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const sheet = window.innerWidth < SHEET_BELOW_PX

  useBackLayer(true, onClose)

  // Kept inside the window: it opens up and to the left when there is no room.
  useLayoutEffect(() => {
    const rect = panel.current?.getBoundingClientRect()

    if (sheet || rect === undefined) return

    setPlace({
      left: Math.max(EDGE_PX, Math.min(at.x, window.innerWidth - rect.width - EDGE_PX)),
      top: Math.max(EDGE_PX, at.y + rect.height > window.innerHeight - EDGE_PX ? at.y - rect.height : at.y),
    })
  }, [at.x, at.y, sheet])

  useEffect(() => {
    const outside = (event: Event): void => {
      if (event.target instanceof Node && panel.current?.contains(event.target) === true) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    if (!sheet) window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)

    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [sheet, onClose])

  const rows = items.map((item, index) =>
    item === null ? (
      <div className="menu-line" key={`line-${index}`} role="separator" />
    ) : (
      <button
        type="button"
        role="menuitem"
        key={item.label}
        className={`menu-item ${item.danger === true ? 'menu-item--danger' : ''}`}
        disabled={item.disabled === true}
        onClick={() => {
          onClose()
          item.onSelect()
        }}
      >
        <span className="menu-item-label">{item.label}</span>
        {item.hint !== undefined && <span className="menu-item-hint">{item.hint}</span>}
      </button>
    ),
  )

  if (sheet) {
    return (
      <div
        className="picker-backdrop"
        onClick={event => {
          if (event.target === event.currentTarget) onClose()
        }}
        onContextMenu={event => event.preventDefault()}
      >
        <div className="picker-sheet menu-sheet" role="menu" ref={panel}>
          <div className="picker-sheet-title">{title}</div>
          {rows}
        </div>
      </div>
    )
  }

  return (
    <div
      className="menu-pop"
      role="menu"
      ref={panel}
      style={place === null ? { left: at.x, top: at.y, visibility: 'hidden' } : { left: place.left, top: place.top }}
      onContextMenu={event => event.preventDefault()}
    >
      {rows}
    </div>
  )
}
