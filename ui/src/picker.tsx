import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useBackLayer } from './back.ts'
import { CheckIcon, ChevronDownIcon } from './icons.tsx'

export type PickerOption<T extends string> = {
  value: T
  label: string
  // A second, quieter line (project, time, path).
  hint?: string
  // A status dot class (dot--working, …) shown before the label.
  dot?: string
  // Rows with the same group sit under one heading, in the order given.
  group?: string
}

type Props<T extends string> = {
  value: T | null
  options: PickerOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  // Shown at the top of the sheet on a phone.
  title?: string
  className?: string
  disabled?: boolean
  // A right click, or a long press on a phone, on one of the rows.
  onOptionMenu?: (value: T, at: { x: number; y: number }) => void
}

// Phones get a sheet from the bottom; wider screens a list under the button.
const SHEET_BELOW_PX = 560
const LIST_MAX_PX = 360

type Place = { top: number; left: number; width: number; maxHeight: number; above: boolean }

// The app's own drop-down, used instead of <select>: the platform's picker
// (Android's radio dialog in particular) looks foreign in the app.
export function Picker<T extends string>({ value, options, onChange, placeholder = '', title, className = '', disabled = false, onOptionMenu }: Props<T>) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState<Place | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.value === value) ?? null
  const sheet = window.innerWidth < SHEET_BELOW_PX

  useBackLayer(open, () => setOpen(false))

  // Fixed to the viewport, so no scrolling or clipped parent can cut it off.
  useLayoutEffect(() => {
    const rect = trigger.current?.getBoundingClientRect()

    if (!open || rect === undefined || sheet) return

    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const upward = below < 220 && above > below

    setPlace({
      top: upward ? Math.max(12, rect.top - 4 - Math.min(LIST_MAX_PX, above)) : rect.bottom + 4,
      left: Math.min(rect.left, window.innerWidth - Math.max(rect.width, 220) - 8),
      width: Math.max(rect.width, 220),
      maxHeight: Math.min(LIST_MAX_PX, upward ? above : below),
      above: upward,
    })
  }, [open, sheet])

  useEffect(() => {
    if (!open) return

    setActive(Math.max(0, options.findIndex(option => option.value === value)))

    const close = (event: Event): void => {
      const target = event.target

      if (target instanceof Node && (panel.current?.contains(target) === true || trigger.current?.contains(target) === true)) return
      setOpen(false)
    }

    // The sheet's dimmed backdrop takes its own taps, so a tap there only
    // closes it and never lands on whatever sits underneath.
    if (!sheet) window.addEventListener('pointerdown', close, true)
    window.addEventListener('resize', close)

    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, sheet])

  useEffect(() => {
    if (open) list.current?.querySelector('.picker-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const choose = (option: PickerOption<T>): void => {
    setOpen(false)
    onChange(option.value)
    trigger.current?.focus()
  }

  const onKey = (event: KeyboardEvent): void => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setOpen(true)
      }

      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(index => (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % Math.max(1, options.length))
    } else if (event.key === 'Enter') {
      event.preventDefault()

      const option = options[active]

      if (option !== undefined) choose(option)
    }
  }

  const rows: Array<{ heading: string } | { option: PickerOption<T>; index: number }> = []
  let lastGroup: string | undefined

  for (const [index, option] of options.entries()) {
    if (option.group !== undefined && option.group !== lastGroup) rows.push({ heading: option.group })
    lastGroup = option.group
    rows.push({ option, index })
  }

  const body = (
    <div className="picker-list" role="listbox" ref={list} onKeyDown={onKey}>
      {rows.map(row =>
        'heading' in row ? (
          <div className="picker-heading" key={`h-${row.heading}`}>
            {row.heading}
          </div>
        ) : (
          <button
            type="button"
            role="option"
            aria-selected={row.option.value === value}
            key={row.option.value}
            className={`picker-row ${row.index === active ? 'active' : ''} ${row.option.value === value ? 'chosen' : ''}`}
            onPointerEnter={() => setActive(row.index)}
            onClick={() => choose(row.option)}
            onContextMenu={event => {
              if (onOptionMenu === undefined) return
              event.preventDefault()
              setOpen(false)
              onOptionMenu(row.option.value, { x: event.clientX, y: event.clientY })
            }}
          >
            {row.option.dot !== undefined && <span className={`status-dot ${row.option.dot}`} />}
            <span className="picker-row-text">
              <span className="picker-row-label">{row.option.label}</span>
              {row.option.hint !== undefined && row.option.hint !== '' && <span className="picker-row-hint">{row.option.hint}</span>}
            </span>
            {row.option.value === value && <CheckIcon size={15} className="picker-check" />}
          </button>
        ),
      )}
    </div>
  )

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={`picker-trigger ${className}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={onKey}
      >
        {selected?.dot !== undefined && <span className={`status-dot ${selected.dot}`} />}
        <span className="picker-trigger-label">{selected?.label ?? placeholder}</span>
        {selected?.hint !== undefined && selected.hint !== '' && <span className="picker-trigger-hint">{selected.hint}</span>}
        <ChevronDownIcon size={13} className="picker-caret" />
      </button>
      {open && sheet && (
        <div
          className="picker-backdrop"
          onClick={event => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div className="picker-sheet" ref={panel}>
            {title !== undefined && <div className="picker-sheet-title">{title}</div>}
            {body}
          </div>
        </div>
      )}
      {open && !sheet && place !== null && (
        <div className={`picker-pop ${place.above ? 'above' : ''}`} ref={panel} style={{ top: place.top, left: place.left, width: place.width, maxHeight: place.maxHeight }}>
          {body}
        </div>
      )}
    </>
  )
}
