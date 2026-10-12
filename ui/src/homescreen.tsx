import { useState } from 'react'
import type { Limits, LiveStream } from '../../shared/protocol.ts'
import { lookFor, type Tone } from './buddy.tsx'
import type { CommandsFn, UploadFn } from './chat.tsx'
import { type Feed, feedFor, limitsFor, type PcSession } from './feeds.ts'
import { Home } from './home.tsx'
import { useI18n } from './i18n.ts'
import { BrowserPane } from './browser.tsx'
import { GlobeIcon, SplitDownIcon, SplitIcon, XIcon } from './icons.tsx'
import { ConnectionContext, type LinkState } from './live.ts'
import { hasBrowser } from './platform.ts'
import { type PcEntry, useSessionNav } from './sessions.tsx'
import { closeLeaf, leavesOf, MAX_TILES, openBrowserBeside, sessionLeavesOf, setLeafSession, splitLeaf, type TileLeaf, TileView, useTiles, useWide } from './tiles.tsx'

// Panes need room: below this width only the pane in focus is drawn.
const SPLIT_MIN_PX = 900

type Props = {
  feeds: Feed[]
  streams: ReadonlyMap<string, LiveStream>
  sessions: PcSession[]
  limits: ReadonlyMap<string, Limits | null>
  codexLimits: ReadonlyMap<string, Limits | null>
  // The session a following pane shows: the one asking, else the one at work.
  auto: PcSession | null
  link: LinkState
  tone: Tone
  now: number
  compact: boolean
  short: boolean
  onSend: (sessionId: string, text: string) => Promise<boolean>
  onUpload: UploadFn
  loadCommands: CommandsFn
  onNewSession: () => void
  // An ended session opens in the chat tab, where its conversation is.
  onOpenChat: (sessionId: string) => void
}

// The home screen, PC by PC: the PCs as buddies, the chosen PC's sessions,
// and live views in panes that split left/right or top/bottom like tmux.
// A pane follows whichever session is busy until a session is picked for it.
export function HomeScreen({ feeds, streams, sessions, limits, codexLimits, auto, link, tone, now, compact, short, onSend, onUpload, loadCommands, onNewSession, onOpenChat }: Props) {
  const { t } = useI18n()
  const [tile, setTile] = useTiles('homeTiles')
  const [focusId, setFocusId] = useState('')
  const wide = useWide(SPLIT_MIN_PX)
  const leaves = leavesOf(tile)
  // The panes with sessions; the browser pane never takes the focus.
  const panes = sessionLeavesOf(tile)
  const focused = panes.find(leaf => leaf.id === focusId) ?? panes[0]
  const sessionOf = (leaf: TileLeaf): PcSession | null => (leaf.sessionId === null ? auto : (sessions.find(session => session.id === leaf.sessionId) ?? null))
  const focusedSession = focused === undefined ? null : sessionOf(focused)
  const shownIds = new Set(panes.flatMap(leaf => (leaf.sessionId === null ? [] : [leaf.sessionId])))
  const canBrowser = hasBrowser && (leaves.length > panes.length || leaves.length < MAX_TILES)

  const show = (leafId: string, sessionId: string | null): void => setTile(current => setLeafSession(current, leafId, sessionId))

  const pick = (entry: PcEntry): void => {
    if (!entry.live) {
      onOpenChat(entry.sessionId)

      return
    }

    if (focused !== undefined) show(focused.id, entry.sessionId)
  }

  const nav = useSessionNav({ feeds, sessions, tone, now, focusedId: focusedSession?.id ?? null, shownIds, onPick: pick, onNewSession })

  // The new pane shows a live session not on screen yet, or follows.
  const split = (leafId: string, dir: 'row' | 'column'): void => {
    if (leaves.length >= MAX_TILES) return

    const next = sessions.find(session => !shownIds.has(session.id) && session.id !== auto?.id) ?? null
    const result = splitLeaf(tile, leafId, dir, next?.id ?? null)

    setTile(() => result.tree)
    setFocusId(result.id)
  }

  const close = (leafId: string): void => {
    const rest = closeLeaf(tile, leafId)

    setTile(() => rest)
    if (leafId === focused?.id) setFocusId(sessionLeavesOf(rest)[0]?.id ?? '')
  }

  const several = wide && leaves.length > 1

  return (
    <div className="convo convo--chat convo--home">
      {nav.rail}
      {nav.list}

      <div className="convo-panes">
        {nav.phoneRow}

        <div className="pane-row">
          <TileView
            tile={tile}
            wide={wide}
            focusedId={focused?.id ?? ''}
            onChange={setTile}
            render={leaf => {
              const session = sessionOf(leaf)
              const feed = feedFor(feeds, session?.pcKey)

              if (leaf.view === 'browser') {
                return (
                  <BrowserPane
                    key={leaf.id}
                    session={session}
                    title={session?.name ?? t('chat.paneEmpty')}
                    onClose={() => close(leaf.id)}
                    onSend={onSend}
                    onUpload={onUpload}
                    loadCommands={loadCommands}
                  />
                )
              }

              return (
                <section
                  key={leaf.id}
                  className={`home-tile ${several && leaf.id === focused?.id ? 'home-tile--focused' : ''}`}
                  onPointerDown={() => setFocusId(leaf.id)}
                >
                  {wide && (
                    <div className="tile-tools">
                      {leaf.sessionId !== null && (
                        <button type="button" className="tile-tool tile-tool--text" onClick={() => show(leaf.id, null)} title={t('home.followHint')}>
                          {t('home.follow')}
                        </button>
                      )}
                      {canBrowser && (
                        <button
                          type="button"
                          className="tile-tool"
                          onClick={() => setTile(current => openBrowserBeside(current, leaf.id, leaf.sessionId))}
                          aria-label={t('browser.openBeside')}
                          title={t('browser.openBeside')}
                        >
                          <GlobeIcon size={14} />
                        </button>
                      )}
                      {leaves.length < MAX_TILES && (
                        <>
                          <button type="button" className="tile-tool" onClick={() => split(leaf.id, 'row')} aria-label={t('chat.split')} title={t('chat.split')}>
                            <SplitIcon size={14} />
                          </button>
                          <button type="button" className="tile-tool" onClick={() => split(leaf.id, 'column')} aria-label={t('chat.splitDown')} title={t('chat.splitDown')}>
                            <SplitDownIcon size={14} />
                          </button>
                        </>
                      )}
                      {panes.length > 1 && (
                        <button type="button" className="tile-tool" onClick={() => close(leaf.id)} aria-label={t('chat.closePane')} title={t('chat.closePane')}>
                          <XIcon size={14} />
                        </button>
                      )}
                    </div>
                  )}
                  <ConnectionContext.Provider value={feed?.connection ?? null}>
                    <Home
                      session={session}
                      stream={session === null ? null : (streams.get(session.id) ?? null)}
                      sessions={sessions}
                      limits={limitsFor({ limits, codexLimits }, session)}
                      look={lookFor(session, leaf.sessionId === null ? link : (feed?.link ?? 'offline'), now)}
                      tone={tone}
                      now={now}
                      compact={compact || several}
                      short={short}
                      onPick={sessionId => show(leaf.id, sessionId)}
                      onSend={onSend}
                      onUpload={onUpload}
                      loadCommands={loadCommands}
                      onNewSession={onNewSession}
                    />
                  </ConnectionContext.Provider>
                </section>
              )
            }}
          />
        </div>
      </div>

      {nav.overlays}
    </div>
  )
}
