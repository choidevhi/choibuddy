import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HistoryEntry } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { Buddy, type Mood, type Pose, tintFor, type Tone } from './buddy.tsx'
import { ConfirmSheet, showToast } from './confirm.tsx'
import { type Feed, feedFor, type PcSession } from './feeds.ts'
import { ago, useI18n } from './i18n.ts'
import { PlusIcon, TerminalIcon } from './icons.tsx'
import { archiveSessions, deleteConversation, endSession, fetchHistory, reloadPlugins, renameSession } from './live.ts'
import { openTerminalTab } from './terminal.tsx'
import { ContextMenu, type MenuEntry } from './menu.tsx'
import { Picker } from './picker.tsx'
import { ON_OFF, usePref } from './prefs.ts'

// A session from any PC, with the PC it lives on.
export type PcEntry = HistoryEntry & { pcKey: string; pcName: string }

export type Groups = { live: PcEntry[]; ended: PcEntry[]; archived: PcEntry[] }

export function groupsOf(entries: PcEntry[], pcKey: string | null): Groups {
  const groups: Groups = { live: [], ended: [], archived: [] }

  for (const entry of entries) {
    if (entry.pcKey !== pcKey) continue
    if (entry.live) groups.live.push(entry)
    else if (entry.archived) groups.archived.push(entry)
    else groups.ended.push(entry)
  }

  return groups
}

export function pcName(feed: Feed): string {
  return feed.snapshot?.server.hostName ?? feed.connection.baseUrl.replace(/^https?:\/\//, '')
}

// A PC's buddy shows how that PC is doing: asking, working, resting or gone.
export function pcLook(feed: Feed, sessions: PcSession[]): { pose: Pose; mood: Mood; status: string } {
  const mine = sessions.filter(session => session.pcKey === feed.key)

  if (feed.link !== 'live') return { pose: 'closed', mood: 'sleep', status: 'ended' }
  if (mine.some(session => session.status === 'waiting')) return { pose: 'warning', mood: 'alert', status: 'waiting' }
  if (mine.some(session => session.status === 'working' || session.status === 'thinking')) return { pose: 'think', mood: 'busy', status: 'working' }

  return { pose: 'base', mood: 'calm', status: mine.length > 0 ? 'idle' : 'ended' }
}

// Every PC's sessions, live ones first, then the newest; read again every
// 30 s, when sessions come and go, and on `reload`.
export function useHistory(feeds: Feed[], sessions: PcSession[]): { entries: PcEntry[]; setEntries: (change: (list: PcEntry[]) => PcEntry[]) => void; reload: () => void } {
  const [history, setHistory] = useState<PcEntry[]>([])
  const [reloadAt, setReloadAt] = useState(0)
  const liveIds = sessions.map(session => session.id).join(',')
  const feedIds = feeds.map(feed => `${feed.key}#${feed.connection.token}`).join('|')

  useEffect(() => {
    const load = (): void => {
      void Promise.all(
        feeds.map(feed =>
          fetchHistory(feed.connection).then(list => list.map((entry): PcEntry => ({ ...entry, pcKey: feed.key, pcName: feed.snapshot?.server.hostName ?? '' }))),
        ),
      ).then(lists => {
        const seen = new Set<string>()
        const merged = lists.flat().filter(entry => {
          if (seen.has(entry.sessionId)) return false
          seen.add(entry.sessionId)

          return true
        })

        setHistory(merged.sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt - a.updatedAt))
      })
    }

    load()

    const timer = window.setInterval(load, 30_000)

    return () => window.clearInterval(timer)
    // feedIds and liveIds stand for the feeds and sessions that matter here.
  }, [feedIds, liveIds, reloadAt])

  // Before the first answer, the live sessions stand in.
  const entries: PcEntry[] =
    history.length > 0
      ? history
      : sessions.map(session => ({
          sessionId: session.id,
          agent: session.agent,
          project: session.name,
          cwd: session.cwd,
          title: '',
          updatedAt: session.updatedAt,
          live: true,
          archived: false,
          pcKey: session.pcKey,
          pcName: session.pcName,
        }))

  return { entries, setEntries: setHistory, reload: () => setReloadAt(Date.now()) }
}

// The connected PCs as buddies of their own colour. A PC's name shows on hover.
export function PcRail({ feeds, sessions, shown, tone, onPick }: { feeds: Feed[]; sessions: PcSession[]; shown: string | null; tone: Tone; onPick: (key: string) => void }) {
  const { t } = useI18n()
  // Drawn on the page itself: inside the scrolling rail it is cut off.
  const [tip, setTip] = useState<{ name: string; top: number; left: number } | null>(null)

  const showTip = (name: string, element: HTMLElement): void => {
    const rect = element.getBoundingClientRect()

    setTip({ name, top: rect.top + rect.height / 2, left: rect.right + 8 })
  }

  return (
    <nav className="pc-rail" aria-label={t('chat.pcs')}>
      {feeds.map(feed => {
        const look = pcLook(feed, sessions)
        const name = feed.local ? `${pcName(feed)} · ${t('connect.thisPc')}` : pcName(feed)

        return (
          <button
            type="button"
            key={feed.key}
            className={`pc-rail-item ${feed.key === shown ? 'on' : ''}`}
            aria-label={name}
            onClick={() => onPick(feed.key)}
            onMouseEnter={event => showTip(name, event.currentTarget)}
            onMouseLeave={() => setTip(null)}
            onFocus={event => showTip(name, event.currentTarget)}
            onBlur={() => setTip(null)}
          >
            <Buddy pose={look.pose} mood={look.mood} tone={tone} tint={tintFor(feed.key)} size={30} />
            {look.status === 'waiting' && <span className="pc-rail-badge" />}
          </button>
        )
      })}
      {tip !== null &&
        createPortal(
          <div className="pc-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
            {tip.name}
          </div>,
          document.body,
        )}
    </nav>
  )
}

// Phones: the PCs as small buddies beside the picker.
export function PcChips({ feeds, sessions, shown, tone, onPick }: { feeds: Feed[]; sessions: PcSession[]; shown: string | null; tone: Tone; onPick: (key: string) => void }) {
  const { t } = useI18n()

  if (feeds.length < 2) return null

  return (
    <div className="pc-chips" role="tablist" aria-label={t('chat.pcs')}>
      {feeds.map(feed => {
        const look = pcLook(feed, sessions)

        return (
          <button
            type="button"
            role="tab"
            key={feed.key}
            aria-selected={feed.key === shown}
            aria-label={pcName(feed)}
            title={pcName(feed)}
            className={`pc-chip ${feed.key === shown ? 'on' : ''}`}
            onClick={() => onPick(feed.key)}
          >
            <Buddy pose={look.pose} mood={look.mood} tone={tone} tint={tintFor(feed.key)} size={24} />
          </button>
        )
      })}
    </div>
  )
}

function RenameSheet({ entry, onSave, onCancel }: { entry: PcEntry; onSave: (title: string) => void; onCancel: () => void }) {
  const { t } = useI18n()
  const [title, setTitle] = useState(entry.title)

  useBackLayer(true, onCancel)

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet confirm-sheet" role="dialog" aria-modal="true" aria-label={t('rename.title')} onClick={event => event.stopPropagation()}>
        <div className="confirm-body">
          <div className="sheet-title">{t('rename.title')}</div>
          <div className="confirm-hint">{t('rename.hint')}</div>
          <input
            className="field"
            autoFocus
            value={title}
            maxLength={120}
            placeholder={entry.project}
            onChange={event => setTitle(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) onSave(title)
            }}
          />
        </div>
        <footer className="sheet-actions">
          <button type="button" className="btn btn--deny" onClick={onCancel}>
            {t('action.cancel')}
          </button>
          <button type="button" className="btn btn--allow" onClick={() => onSave(title)}>
            {t('rename.save')}
          </button>
        </footer>
      </div>
    </div>
  )
}

// What the right click (or long press) opened, and where.
type MenuState = { entry: PcEntry; at: { x: number; y: number } }

// A question before ending a session or deleting conversations.
type Asking = { kind: 'end'; entry: PcEntry } | { kind: 'delete'; entries: PcEntry[] }

type NavOptions = {
  feeds: Feed[]
  sessions: PcSession[]
  tone: Tone
  now: number
  // The session in focus: the list marks it and follows its PC.
  focusedId: string | null
  // Sessions shown elsewhere on screen (other panes), marked more lightly.
  shownIds: ReadonlySet<string>
  onPick: (entry: PcEntry) => void
  onNewSession: () => void
  // A conversation went to the trash.
  onDeleted?: (sessionId: string) => void
}

export type SessionNav = {
  entries: PcEntry[]
  entryOf: (sessionId: string | null) => PcEntry | null
  shownPc: string | null
  rail: ReactNode
  list: ReactNode
  // The phone's row: PC chips, a session picker and the new-session button.
  phoneRow: ReactNode
  overlays: ReactNode
}

// The PCs, the chosen PC's sessions (open, ended, archive) and the session
// menu (rename, end, archive, delete), shared by the home, chat and images
// screens.
export function useSessionNav({ feeds, sessions, tone, now, focusedId, shownIds, onPick, onNewSession, onDeleted }: NavOptions): SessionNav {
  const { t } = useI18n()
  const { entries, setEntries, reload } = useHistory(feeds, sessions)
  const [pcKey, setPcKey] = useState<string | null>(null)
  const [showArchive, setShowArchive] = useState(false)
  // The ended sessions can be folded away, and stay so.
  const [foldEnded, setFoldEnded] = usePref('foldEnded', ON_OFF, 'off')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<PcEntry | null>(null)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [busy, setBusy] = useState(false)

  const entryOf = (sessionId: string | null): PcEntry | null => (sessionId === null ? null : (entries.find(entry => entry.sessionId === sessionId) ?? null))
  const focusedPc = entryOf(focusedId)?.pcKey ?? null

  // The list follows the PC of the session in focus (picked here or elsewhere).
  useEffect(() => {
    if (focusedPc !== null) setPcKey(focusedPc)
  }, [focusedPc])

  const shownPc = pcKey !== null && feeds.some(feed => feed.key === pcKey) ? pcKey : (focusedPc ?? feeds[0]?.key ?? null)
  const shownFeed = feeds.find(feed => feed.key === shownPc) ?? null
  const groups = groupsOf(entries, shownPc)
  const statusOf = (entry: PcEntry): string => (entry.live ? (sessions.find(session => session.id === entry.sessionId)?.status ?? 'ended') : 'ended')
  const titleOf = (entry: PcEntry): string => (entry.title === '' ? t('chat.untitled') : entry.title)
  const metaOf = (entry: PcEntry): string => `${entry.project} · ${entry.live ? t('chat.live') : ago(t, now - entry.updatedAt)}`
  const connectionOf = (entry: PcEntry) => feedFor(feeds, entry.pcKey)?.connection ?? null

  const archive = async (list: PcEntry[], archived: boolean): Promise<void> => {
    const connection = list[0] === undefined ? null : connectionOf(list[0])

    if (connection === null) return

    const ids = new Set(list.map(entry => entry.sessionId))

    if (!(await archiveSessions(connection, [...ids], archived))) {
      showToast(t('chat.actionFailed'))

      return
    }

    setEntries(current => current.map(entry => (ids.has(entry.sessionId) ? { ...entry, archived } : entry)))
    showToast(archived ? t('chat.archivedToast', { n: ids.size }) : t('chat.unarchivedToast', { n: ids.size }))
  }

  const rename = async (entry: PcEntry, title: string): Promise<void> => {
    const connection = connectionOf(entry)

    setRenaming(null)

    if (connection === null || !(await renameSession(connection, entry.sessionId, title))) {
      showToast(t('chat.actionFailed'))

      return
    }

    // An empty name goes back to Claude Code's, which the list reads again.
    if (title.trim() === '') reload()
    else setEntries(current => current.map(item => (item.sessionId === entry.sessionId ? { ...item, title: title.replace(/\s+/g, ' ').trim() } : item)))
  }

  const end = async (entry: PcEntry): Promise<void> => {
    const connection = connectionOf(entry)
    const result = connection === null ? 'failed' : await endSession(connection, entry.sessionId)

    showToast(result === 'sent' ? t('chat.endSent') : result === 'no-mod' ? t('chat.endNoMod') : t('chat.actionFailed'))
  }

  const remove = async (list: PcEntry[]): Promise<void> => {
    let failed = 0

    for (const entry of list) {
      const connection = connectionOf(entry)
      const result = connection === null ? 'failed' : await deleteConversation(connection, entry.sessionId)

      if (result === 'deleted') {
        setEntries(current => current.filter(item => item.sessionId !== entry.sessionId))
        onDeleted?.(entry.sessionId)
      } else {
        failed += 1
      }
    }

    if (failed > 0) showToast(t('chat.actionFailed'))
  }

  // A terminal on the session's PC, in its folder (or the PC's home
  // folder), inside the app's terminal tab.
  const terminal = (pcKey: string, cwd: string): void => openTerminalTab({ pcKey, cwd, run: 'shell', prompt: '', title: '' })

  const reloadSession = async (entry: PcEntry): Promise<void> => {
    const connection = feedFor(feeds, entry.pcKey)?.connection ?? null

    showToast(connection !== null && (await reloadPlugins(connection, entry.sessionId)) ? t('mod.reloadQueued') : t('chat.actionFailed'))
  }

  const menuItems = (entry: PcEntry): Array<MenuEntry | null> => {
    const renameItem: MenuEntry = { label: t('menu.rename'), onSelect: () => setRenaming(entry) }
    const terminalItem: MenuEntry = { label: t('menu.terminal'), onSelect: () => terminal(entry.pcKey, entry.cwd) }

    if (entry.live) {
      const canEnd = sessions.find(session => session.id === entry.sessionId)?.canPrompt === true
      const reloadItem: MenuEntry = { label: t('menu.reload'), disabled: !canEnd, hint: canEnd ? undefined : t('menu.endNoMod'), onSelect: () => void reloadSession(entry) }

      return [renameItem, terminalItem, reloadItem, null, { label: t('menu.end'), danger: true, disabled: !canEnd, hint: canEnd ? undefined : t('menu.endNoMod'), onSelect: () => setAsking({ kind: 'end', entry }) }]
    }

    const ended = groupsOf(entries, entry.pcKey).ended

    return [
      renameItem,
      terminalItem,
      { label: entry.archived ? t('menu.unarchive') : t('menu.archive'), onSelect: () => void archive([entry], !entry.archived) },
      { label: t('menu.delete'), danger: true, onSelect: () => setAsking({ kind: 'delete', entries: [entry] }) },
      null,
      { label: t('chat.archiveEnded', { n: ended.length }), disabled: ended.length === 0, onSelect: () => void archive(ended, true) },
      { label: t('chat.deleteEnded', { n: ended.length }), danger: true, disabled: ended.length === 0, onSelect: () => setAsking({ kind: 'delete', entries: ended }) },
    ]
  }

  const openMenu = (entry: PcEntry, at: { x: number; y: number }): void => setMenu({ entry, at })

  const row = (entry: PcEntry) => (
    <button
      type="button"
      key={entry.sessionId}
      className={`convo-item ${entry.sessionId === focusedId ? 'on' : shownIds.has(entry.sessionId) ? 'shown' : ''} ${entry.live ? '' : 'convo-item--ended'}`}
      onClick={() => onPick(entry)}
      onContextMenu={event => {
        event.preventDefault()
        openMenu(entry, { x: event.clientX, y: event.clientY })
      }}
    >
      <span className={`status-dot convo-dot dot--${statusOf(entry)}`} />
      <span className="convo-item-text">
        <span className="convo-title">
          {entry.agent === 'codex' && <span className="agent-chip">Codex</span>}
          {titleOf(entry)}
        </span>
        <span className="convo-meta">{metaOf(entry)}</span>
      </span>
    </button>
  )

  const option = (entry: PcEntry, group: string) => ({ value: entry.sessionId, label: titleOf(entry), hint: metaOf(entry), dot: `dot--${statusOf(entry)}`, group })

  const rail = <PcRail feeds={feeds} sessions={sessions} shown={shownPc} tone={tone} onPick={setPcKey} />

  const list = (
    <aside className="convo-list">
      <div className="section-label convo-list-head">
        <span className="convo-list-pc">{shownFeed === null ? t('chat.sessions') : pcName(shownFeed)}</span>
        {shownPc !== null && (
          <button type="button" className="icon-btn convo-list-tool" onClick={() => terminal(shownPc, '')} title={t('terminal.open')} aria-label={t('terminal.open')}>
            <TerminalIcon size={15} />
          </button>
        )}
        <button type="button" className="btn small" onClick={onNewSession} title={t('newSession.title')}>
          <PlusIcon size={13} /> {t('chat.newSession')}
        </button>
      </div>
      {groups.live.map(row)}
      {groups.live.length === 0 && <div className="convo-none">{t('chat.noOpen')}</div>}
      {groups.ended.length > 0 && (
        <div className="convo-divider">
          <button type="button" className="convo-divider-label convo-fold" onClick={() => setFoldEnded(foldEnded === 'on' ? 'off' : 'on')} aria-expanded={foldEnded !== 'on'}>
            <span className="convo-fold-caret">{foldEnded === 'on' ? '▸' : '▾'}</span>
            {t('chat.groupEnded')} · {groups.ended.length}
          </button>
          <button type="button" className="link-btn" onClick={() => void archive(groups.ended, true)}>
            {t('chat.archiveAll')}
          </button>
          <button type="button" className="link-btn link-btn--danger" onClick={() => setAsking({ kind: 'delete', entries: groups.ended })}>
            {t('chat.deleteAll')}
          </button>
        </div>
      )}
      {foldEnded !== 'on' && groups.ended.map(row)}
      {groups.archived.length > 0 && (
        <button type="button" className="convo-divider convo-archive-toggle" onClick={() => setShowArchive(!showArchive)} aria-expanded={showArchive}>
          <span className="convo-divider-label">
            {t('chat.groupArchived')} · {groups.archived.length}
          </span>
          <span className="picker-caret">{showArchive ? '▾' : '▸'}</span>
        </button>
      )}
      {showArchive && groups.archived.map(row)}
    </aside>
  )

  const phoneRow = (
    <div className="convo-select-row">
      <PcChips feeds={feeds} sessions={sessions} shown={shownPc} tone={tone} onPick={setPcKey} />
      <Picker
        className="convo-select"
        value={focusedId}
        title={shownFeed === null ? t('chat.sessions') : pcName(shownFeed)}
        placeholder={t('chat.empty')}
        options={[
          ...groups.live.map(entry => option(entry, t('chat.groupLive'))),
          ...groups.ended.map(entry => option(entry, t('chat.groupEnded'))),
          ...groups.archived.map(entry => option(entry, t('chat.groupArchived'))),
        ]}
        onChange={sessionId => {
          const entry = entryOf(sessionId)

          if (entry !== null) onPick(entry)
        }}
        onOptionMenu={(sessionId, at) => {
          const entry = entryOf(sessionId)

          if (entry !== null) openMenu(entry, at)
        }}
      />
      <button type="button" className="icon-btn convo-new" onClick={onNewSession} title={t('newSession.title')}>
        <PlusIcon size={17} />
      </button>
    </div>
  )

  const overlays = (
    <>
      {menu !== null && <ContextMenu at={menu.at} title={titleOf(menu.entry)} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
      {renaming !== null && <RenameSheet entry={renaming} onSave={title => void rename(renaming, title)} onCancel={() => setRenaming(null)} />}
      {asking !== null && (
        <ConfirmSheet
          title={asking.kind === 'end' ? t('chat.endTitle') : asking.entries.length === 1 ? t('chat.deleteTitle') : t('chat.deleteManyTitle', { n: asking.entries.length })}
          hint={asking.kind === 'end' ? `${titleOf(asking.entry)}\n\n${t('chat.endHint')}` : t('chat.deleteHint')}
          confirmLabel={asking.kind === 'end' ? t('chat.endConfirm') : t('action.delete')}
          busy={busy}
          onConfirm={() => {
            const current = asking

            setBusy(true)
            void (current.kind === 'end' ? end(current.entry) : remove(current.entries)).finally(() => {
              setBusy(false)
              setAsking(null)
            })
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  )

  return { entries, entryOf, shownPc, rail, list, phoneRow, overlays }
}
