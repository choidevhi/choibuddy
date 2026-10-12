import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'

// A picture that zooms: pinch, drag and double-tap on a phone (Android's
// WebView never zooms the page), the wheel, drag and double-click on a PC.
// Zoomed in, it moves only as far as its own edges.

const MAX_SCALE = 6
const TAP_SCALE = 2.5
const DOUBLE_TAP_MS = 320
const TAP_SLOP = 12
const WHEEL_STEP = 0.0015

type View = { scale: number; x: number; y: number }

type Point = { x: number; y: number }

// Where the fingers on it started: the view then, their middle and spread.
type Gesture = { view: View; center: Point; spread: number }

const FIT: View = { scale: 1, x: 0, y: 0 }

function middle(points: Point[]): Point {
  let x = 0
  let y = 0

  for (const point of points) {
    x += point.x
    y += point.y
  }

  return { x: x / points.length, y: y / points.length }
}

function spreadOf(points: Point[]): number {
  const [a, b] = points

  return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y)
}

function bounded(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(1, scale))
}

// The view zoomed to `scale`, with the spot under `at` kept under it.
function zoomAt(view: View, scale: number, at: Point): View {
  const factor = scale / view.scale

  return { scale, x: at.x - (at.x - view.x) * factor, y: at.y - (at.y - view.y) * factor }
}

// The picture's size as fitted in its box (object-fit: contain), unzoomed.
function fitted(box: HTMLElement): { width: number; height: number } {
  const image = box.querySelector('img')

  if (image === null || image.naturalWidth === 0 || image.naturalHeight === 0) return { width: box.clientWidth, height: box.clientHeight }

  const ratio = Math.min(image.clientWidth / image.naturalWidth, image.clientHeight / image.naturalHeight)

  return { width: image.naturalWidth * ratio, height: image.naturalHeight * ratio }
}

// Points are kept from the middle of the box, where the zoom is anchored.
function pointIn(box: HTMLElement, event: { clientX: number; clientY: number }): Point {
  const rect = box.getBoundingClientRect()

  return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
}

export function ZoomView({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>(FIT)
  const [easing, setEasing] = useState(false)
  const current = useRef<View>(FIT)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  // How far the fingers went, and how many were down, since the first one.
  const travel = useRef(0)
  const fingers = useRef(0)
  const lastTap = useRef<{ at: number; point: Point } | null>(null)

  // The view kept inside the picture's edges, then shown.
  const show = (next: View, ease: boolean): void => {
    const element = box.current
    const scale = bounded(next.scale)
    let kept = FIT

    if (element !== null && scale > 1) {
      const { width, height } = fitted(element)
      const limitX = Math.max(0, (width * scale - element.clientWidth) / 2)
      const limitY = Math.max(0, (height * scale - element.clientHeight) / 2)

      kept = { scale, x: Math.min(limitX, Math.max(-limitX, next.x)), y: Math.min(limitY, Math.max(-limitY, next.y)) }
    }

    current.current = kept
    setEasing(ease)
    setView(kept)
  }

  const begin = (): void => {
    const points = [...pointers.current.values()]

    gesture.current = points.length === 0 ? null : { view: current.current, center: middle(points), spread: spreadOf(points) }
  }

  const tap = (point: Point): void => {
    const now = Date.now()
    const last = lastTap.current

    if (last !== null && now - last.at < DOUBLE_TAP_MS && Math.hypot(point.x - last.point.x, point.y - last.point.y) < TAP_SLOP * 3) {
      lastTap.current = null
      show(current.current.scale > 1 ? FIT : zoomAt(current.current, TAP_SCALE, point), true)

      return
    }

    lastTap.current = { at: now, point }
  }

  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // A button on the picture (retry) keeps its own click.
    if (event.target instanceof Element && event.target.closest('button') !== null) return

    const element = event.currentTarget

    element.setPointerCapture(event.pointerId)

    if (pointers.current.size === 0) {
      travel.current = 0
      fingers.current = 0
    }

    pointers.current.set(event.pointerId, pointIn(element, event))
    fingers.current = Math.max(fingers.current, pointers.current.size)
    begin()
  }

  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = gesture.current

    if (start === null || !pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, pointIn(event.currentTarget, event))

    const points = [...pointers.current.values()]
    const center = middle(points)
    const moved = { x: center.x - start.center.x, y: center.y - start.center.y }

    travel.current = Math.max(travel.current, Math.hypot(moved.x, moved.y))

    if (points.length >= 2 && start.spread > 0) {
      const zoomed = zoomAt(start.view, bounded((start.view.scale * spreadOf(points)) / start.spread), start.center)

      show({ scale: zoomed.scale, x: zoomed.x + moved.x, y: zoomed.y + moved.y }, false)

      return
    }

    // One finger moves a zoomed picture; a fitted one stays where it is.
    if (start.view.scale > 1) show({ scale: start.view.scale, x: start.view.x + moved.x, y: start.view.y + moved.y }, false)
  }

  const up = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.delete(event.pointerId)) return

    // The fingers left keep going from where the picture is now.
    if (pointers.current.size > 0) {
      begin()

      return
    }

    gesture.current = null

    if (event.type === 'pointerup' && fingers.current === 1 && travel.current <= TAP_SLOP) tap(pointIn(event.currentTarget, event))
    else lastTap.current = null
  }

  // The wheel zooms around the pointer; listened to directly, since React's
  // wheel listener cannot keep the page from scrolling.
  useEffect(() => {
    const element = box.current

    if (element === null) return

    const wheel = (event: WheelEvent): void => {
      event.preventDefault()

      const now = current.current

      show(zoomAt(now, bounded(now.scale * Math.exp(-event.deltaY * WHEEL_STEP)), pointIn(element, event)), false)
    }

    element.addEventListener('wheel', wheel, { passive: false })

    return () => element.removeEventListener('wheel', wheel)
  }, [])

  return (
    <div ref={box} className={`zoom ${view.scale > 1 ? 'zoom--in' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className={`zoom-content ${easing ? 'zoom-content--ease' : ''}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        {children}
      </div>
    </div>
  )
}
