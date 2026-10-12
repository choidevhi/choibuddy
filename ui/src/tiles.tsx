import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useState } from 'react'

// Panes laid out like tmux: a pane splits into two side by side ("row") or
// one over the other ("column"), and each half can split again. A pane
// shows one session, or follows whichever session is busy (null). One pane
// can hold the browser instead (Windows), working for its session.
export type PaneKind = 'session' | 'browser'

export type TileLeaf = { kind: 'leaf'; id: string; sessionId: string | null; view: PaneKind }

export type TileSplit = { kind: 'split'; id: string; dir: 'row' | 'column'; ratio: number; a: Tile; b: Tile }

export type Tile = TileLeaf | TileSplit

export const MAX_TILES = 6

const MIN_RATIO = 0.15

// The stored form, checked node by node when read back.
type StoredTile = { kind?: string; id?: string; sessionId?: string | null; view?: string; dir?: string; ratio?: number; a?: StoredTile; b?: StoredTile } | null

function newId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function single(sessionId: string | null): Tile {
  return { kind: 'leaf', id: newId(), sessionId, view: 'session' }
}

export function leavesOf(tile: Tile): TileLeaf[] {
  return tile.kind === 'leaf' ? [tile] : [...leavesOf(tile.a), ...leavesOf(tile.b)]
}

// The panes that show sessions, not the browser.
export function sessionLeavesOf(tile: Tile): TileLeaf[] {
  return leavesOf(tile).filter(leaf => leaf.view === 'session')
}

// Splits a pane in two; the new pane (right of it or under it) shows `sessionId`.
export function splitLeaf(tile: Tile, leafId: string, dir: 'row' | 'column', sessionId: string | null, view: PaneKind = 'session'): { tree: Tile; id: string } {
  const added: TileLeaf = { kind: 'leaf', id: newId(), sessionId, view }

  const walk = (node: Tile): Tile => {
    if (node.kind === 'leaf') return node.id === leafId ? { kind: 'split', id: newId(), dir, ratio: 0.5, a: node, b: added } : node

    return { ...node, a: walk(node.a), b: walk(node.b) }
  }

  return { tree: walk(tile), id: added.id }
}

// Closes a pane; its neighbour takes the room. The last pane stays.
export function closeLeaf(tile: Tile, leafId: string): Tile {
  if (tile.kind === 'leaf') return tile
  if (tile.a.kind === 'leaf' && tile.a.id === leafId) return tile.b
  if (tile.b.kind === 'leaf' && tile.b.id === leafId) return tile.a

  return { ...tile, a: closeLeaf(tile.a, leafId), b: closeLeaf(tile.b, leafId) }
}

// The browser beside a pane, for that pane's session. There is one browser,
// so an open one moves here.
export function openBrowserBeside(tile: Tile, leafId: string, sessionId: string | null): Tile {
  const open = leavesOf(tile).find(leaf => leaf.view === 'browser')
  const rest = open === undefined ? tile : closeLeaf(tile, open.id)

  return splitLeaf(rest, leafId, 'row', sessionId, 'browser').tree
}

export function setLeafSession(tile: Tile, leafId: string, sessionId: string | null): Tile {
  if (tile.kind === 'leaf') return tile.id === leafId ? { ...tile, sessionId } : tile

  return { ...tile, a: setLeafSession(tile.a, leafId, sessionId), b: setLeafSession(tile.b, leafId, sessionId) }
}

function setRatio(tile: Tile, splitId: string, ratio: number): Tile {
  if (tile.kind === 'leaf') return tile
  if (tile.id === splitId) return { ...tile, ratio }

  return { ...tile, a: setRatio(tile.a, splitId, ratio), b: setRatio(tile.b, splitId, ratio) }
}

export function parseTile(stored: StoredTile): Tile | null {
  if (stored === null || typeof stored.id !== 'string') return null
  if (stored.kind === 'leaf') return { kind: 'leaf', id: stored.id, sessionId: typeof stored.sessionId === 'string' ? stored.sessionId : null, view: stored.view === 'browser' ? 'browser' : 'session' }
  if (stored.kind !== 'split' || (stored.dir !== 'row' && stored.dir !== 'column')) return null

  const a = parseTile(stored.a ?? null)
  const b = parseTile(stored.b ?? null)
  const ratio = typeof stored.ratio === 'number' ? Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, stored.ratio)) : 0.5

  return a === null || b === null ? null : { kind: 'split', id: stored.id, dir: stored.dir, ratio, a, b }
}

function readTiles(key: string): Tile {
  try {
    const stored: StoredTile = JSON.parse(localStorage.getItem(`choibuddy.${key}`) ?? 'null')
    const tile = parseTile(stored)

    // A layout always keeps a session pane.
    return tile !== null && sessionLeavesOf(tile).length > 0 ? tile : single(null)
  } catch {
    return single(null)
  }
}

// The layout, remembered on this device per screen.
export function useTiles(key: string): [Tile, (change: (tile: Tile) => Tile) => void] {
  const [tile, setTile] = useState<Tile>(() => readTiles(key))

  useEffect(() => {
    try {
      localStorage.setItem(`choibuddy.${key}`, JSON.stringify(tile))
    } catch {
      // Remembering the layout is a convenience.
    }
  }, [tile])

  return [tile, setTile]
}

type ViewProps = {
  tile: Tile
  // On a narrow screen only the pane in focus is drawn.
  wide: boolean
  focusedId: string
  render: (leaf: TileLeaf) => ReactNode
  onChange: (change: (tile: Tile) => Tile) => void
}

export function TileView({ tile, wide, focusedId, render, onChange }: ViewProps) {
  if (!wide) {
    const leaves = leavesOf(tile)
    const focused = leaves.find(leaf => leaf.id === focusedId) ?? leaves[0]

    return focused === undefined ? null : <div className="tile">{render(focused)}</div>
  }

  return <Node tile={tile} render={render} onChange={onChange} />
}

function Node({ tile, render, onChange }: { tile: Tile; render: (leaf: TileLeaf) => ReactNode; onChange: (change: (tile: Tile) => Tile) => void }) {
  if (tile.kind === 'leaf') return <div className="tile">{render(tile)}</div>

  // Dragging the line between the halves moves their shares.
  const drag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const parent = event.currentTarget.parentElement

    if (parent === null) return

    const rect = parent.getBoundingClientRect()

    const move = (next: PointerEvent): void => {
      const share = tile.dir === 'row' ? (next.clientX - rect.left) / rect.width : (next.clientY - rect.top) / rect.height

      onChange(current => setRatio(current, tile.id, Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, share))))
    }

    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing', 'resizing--column')
    }

    document.body.classList.add('resizing')
    if (tile.dir === 'column') document.body.classList.add('resizing--column')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className={`tiles tiles--${tile.dir}`}>
      <div className="tiles-half" style={{ flexGrow: tile.ratio }}>
        <Node tile={tile.a} render={render} onChange={onChange} />
      </div>
      <div className={`tiles-divider tiles-divider--${tile.dir}`} role="separator" aria-orientation={tile.dir === 'row' ? 'vertical' : 'horizontal'} onPointerDown={drag} />
      <div className="tiles-half" style={{ flexGrow: 1 - tile.ratio }}>
        <Node tile={tile.b} render={render} onChange={onChange} />
      </div>
    </div>
  )
}

// A conversation that went to the trash leaves its panes empty.
export function forgetSession(tile: Tile, sessionId: string): Tile {
  if (tile.kind === 'leaf') return tile.sessionId === sessionId ? { ...tile, sessionId: null } : tile

  return { ...tile, a: forgetSession(tile.a, sessionId), b: forgetSession(tile.b, sessionId) }
}

// Wide enough to show several panes at once.
export function useWide(minPx: number): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= minPx)

  useEffect(() => {
    const onResize = (): void => setWide(window.innerWidth >= minPx)

    window.addEventListener('resize', onResize)

    return () => window.removeEventListener('resize', onResize)
  }, [minPx])

  return wide
}
