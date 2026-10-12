import { FitAddon } from '@xterm/addon-fit'
import { type ITheme, Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type { Tone } from './buddy.tsx'
import { showToast } from './confirm.tsx'
import { type Feed, feedFor, type PcSession } from './feeds.ts'
import { useI18n } from './i18n.ts'
import { PlusIcon, TerminalIcon, XIcon } from './icons.tsx'
import { fetchTerms, openTerm, type TermInfo, termClose, termInput, termResize, type TermRun, type TermState, termStreamUrl } from './live.ts'
import type { Connection } from './platform.ts'
import { PcChips, pcName, PcRail } from './sessions.tsx'
import { useWide } from './tiles.tsx'

// Something elsewhere in the app asks for a terminal: the session list's
// button, a session's menu, the new session sheet.
export type TermRequest = { pcKey: string; cwd: string; run: TermRun; prompt: string; title: string }

const EVENT = 'choibuddy-terminal'

export function openTerminalTab(request: TermRequest): void {
  window.dispatchEvent(new CustomEvent<TermRequest>(EVENT, { detail: request }))
}

export function useTerminalRequests(onRequest: (request: TermRequest) => void): void {
  const latest = useRef(onRequest)

  useEffect(() => {
    latest.current = onRequest
  })

  useEffect(() => {
    const listen = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail?.pcKey === 'string') latest.current(event.detail)
    }

    window.addEventListener(EVENT, listen)

    return () => window.removeEventListener(EVENT, listen)
  }, [])
}

const DARK: ITheme = { background: '#111214', foreground: '#e6e6e6', cursor: '#e6e6e6', selectionBackground: '#3b4252' }
const LIGHT: ITheme = { background: '#fbfbfc', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: '#cfd8ea' }

// Keys a phone keyboard does not have.
const KEYS: Array<[string, string]> = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['Ctrl+C', '\x03'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
]

// The tab comes and goes with the tab bar: what it showed, and the last ask
// it opened, outlive it so coming back neither loses the place nor opens the
// same terminal twice.
let lastPc: string | null = null
let lastActive: string | null = null
let handledAt = 0

const LIST_MS = 4000
const INPUT_MS = 8
const RESIZE_MS = 120

// One terminal: what it prints, and what is typed going back as it is typed.
function TerminalView({ connection, term, dark, keys }: { connection: Connection; term: TermInfo; dark: boolean; keys: boolean }) {
  const { t } = useI18n()
  const host = useRef<HTMLDivElement>(null)
  const screen = useRef<Terminal | null>(null)

  useEffect(() => {
    const element = host.current

    if (element === null) return

    const xterm = new Terminal({ fontFamily: '"JetBrains Mono Variable", Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, theme: dark ? DARK : LIGHT })
    const fit = new FitAddon()
    let pending = ''
    let inputTimer = 0
    let resizeTimer = 0
    // The stream starts with everything printed so far, also after it reconnects.
    let fresh = true

    xterm.loadAddon(fit)
    xterm.open(element)
    fit.fit()
    screen.current = xterm

    const send = (): void => {
      inputTimer = 0

      const data = pending

      pending = ''
      if (data !== '') void termInput(connection, term.id, data)
    }
    const typed = xterm.onData(data => {
      pending += data
      if (inputTimer === 0) inputTimer = window.setTimeout(send, INPUT_MS)
    })
    const stream = new EventSource(termStreamUrl(connection, term.id))

    stream.addEventListener('open', () => {
      fresh = true
    })
    stream.addEventListener('out', event => {
      const text = JSON.parse(event.data)

      if (typeof text !== 'string') return
      if (fresh) xterm.reset()
      fresh = false
      xterm.write(text)
    })
    stream.addEventListener('exit', () => xterm.write(`\r\n\x1b[2m${t('terminal.ended')}\x1b[0m\r\n`))

    const fitNow = (): void => {
      fit.fit()
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => void termResize(connection, term.id, xterm.cols, xterm.rows), RESIZE_MS)
    }
    const observer = new ResizeObserver(fitNow)

    observer.observe(element)
    fitNow()
    xterm.focus()

    return () => {
      observer.disconnect()
      stream.close()
      typed.dispose()
      window.clearTimeout(inputTimer)
      window.clearTimeout(resizeTimer)
      xterm.dispose()
      screen.current = null
    }
  }, [connection.baseUrl, connection.token, term.id])

  useEffect(() => {
    if (screen.current !== null) screen.current.options.theme = dark ? DARK : LIGHT
  }, [dark])

  return (
    <div className="term-view">
      <div className="term-screen" ref={host} />
      {keys && (
        <div className="term-keys">
          {KEYS.map(([label, data]) => (
            <button
              type="button"
              key={label}
              className="term-key"
              onPointerDown={event => event.preventDefault()}
              onClick={() => {
                void termInput(connection, term.id, data)
                screen.current?.focus()
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type Props = {
  feeds: Feed[]
  sessions: PcSession[]
  tone: Tone
  dark: boolean
  // The latest ask for a terminal, and a number that changes with each ask.
  request: (TermRequest & { at: number }) | null
}

// Terminals on the PCs, inside the app: the PCs on the left, the chosen PC's
// terminals next to them, the terminal itself on the right. Typing goes
// straight to the PC; the phone gets keys its keyboard lacks.
export function TerminalTab({ feeds, sessions, tone, dark, request }: Props) {
  const { t } = useI18n()
  // Side by side above the stylesheet's 700px phone layout.
  const wide = useWide(701)
  const [pcKey, setPcKey] = useState<string | null>(lastPc)
  const [state, setState] = useState<TermState | null>(null)
  const [activeId, setActiveId] = useState<string | null>(lastActive)
  const [reloadAt, setReloadAt] = useState(0)
  const shownPc = pcKey !== null && feeds.some(feed => feed.key === pcKey) ? pcKey : (feeds.find(feed => feed.local)?.key ?? feeds[0]?.key ?? null)
  const feed = feedFor(feeds, shownPc ?? undefined)

  useEffect(() => {
    lastPc = pcKey
    lastActive = activeId
  }, [pcKey, activeId])

  useEffect(() => {
    if (feed === null) return

    let stopped = false

    const load = (): void => {
      void fetchTerms(feed.connection).then(next => {
        if (!stopped) setState(next)
      })
    }

    load()

    const timer = window.setInterval(load, LIST_MS)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [feed?.key, feed?.connection.token, reloadAt])

  const open = async (target: Feed, ask: Omit<TermRequest, 'pcKey'>): Promise<void> => {
    const opened = await openTerm(target.connection, { ...ask, cols: 100, rows: 30 })

    if (typeof opened === 'string') {
      showToast(t('terminal.openFailed', { reason: opened }))

      return
    }

    setPcKey(target.key)
    setActiveId(opened.id)
    setReloadAt(Date.now())
  }

  // An ask from elsewhere opens once.
  useEffect(() => {
    if (request === null || request.at === handledAt) return
    handledAt = request.at

    const target = feedFor(feeds, request.pcKey)

    if (target !== null) void open(target, request)
  }, [request?.at])

  const terminals = state?.terminals ?? []
  const active = terminals.find(term => term.id === activeId) ?? (wide ? terminals[0] : undefined) ?? null

  const close = async (term: TermInfo): Promise<void> => {
    if (feed !== null && (await termClose(feed.connection, term.id))) {
      if (activeId === term.id) setActiveId(null)
      setReloadAt(Date.now())
    }
  }

  const newShell = (): void => {
    if (feed !== null) void open(feed, { cwd: '', run: 'shell', prompt: '', title: '' })
  }

  const list = (
    <aside className="convo-list term-list">
      <div className="section-label convo-list-head">
        <span className="convo-list-pc">{feed === null ? t('tab.terminal') : pcName(feed)}</span>
        <button type="button" className="btn small" disabled={state === null || !state.allowed || !state.available} onClick={newShell}>
          <PlusIcon size={13} /> {t('terminal.new')}
        </button>
      </div>
      {!wide && <PcChips feeds={feeds} sessions={sessions} shown={shownPc} tone={tone} onPick={setPcKey} />}
      {state !== null && !state.available && <div className="convo-none">{t('terminal.unavailable')}</div>}
      {state !== null && state.available && !state.allowed && <div className="convo-none">{t('terminal.notAllowed')}</div>}
      {state !== null && state.allowed && terminals.length === 0 && <div className="convo-none">{t('terminal.none')}</div>}
      {terminals.map(term => (
        <div key={term.id} className={`convo-item term-item ${active?.id === term.id ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => setActiveId(term.id)}>
          <span className={`status-dot convo-dot dot--${term.exited ? 'ended' : 'working'}`} />
          <span className="convo-item-text">
            <span className="convo-title">
              {term.run !== 'shell' && <span className="agent-chip">{term.run === 'codex' ? 'Codex' : 'Claude'}</span>}
              {term.title !== '' ? term.title : (term.cwd.split(/[\\/]/).at(-1) ?? term.cwd)}
            </span>
            <span className="convo-meta">{term.cwd}</span>
          </span>
          <button
            type="button"
            className="icon-btn term-close"
            title={t('terminal.close')}
            aria-label={t('terminal.close')}
            onClick={event => {
              event.stopPropagation()
              void close(term)
            }}
          >
            <XIcon size={13} />
          </button>
        </div>
      ))}
    </aside>
  )

  const view =
    active !== null && feed !== null ? (
      <section className="convo-main term-main">
        {!wide && (
          <button type="button" className="btn small term-back" onClick={() => setActiveId(null)}>
            ← {t('terminal.list')}
          </button>
        )}
        <TerminalView key={`${feed.key}-${active.id}`} connection={feed.connection} term={active} dark={dark} keys={!wide} />
      </section>
    ) : (
      wide && (
        <section className="convo-main">
          <div className="empty">
            <TerminalIcon size={28} className="dim" />
            <div className="empty-title">{t('terminal.pick')}</div>
            <div className="empty-sub">{t('terminal.hint')}</div>
          </div>
        </section>
      )
    )

  return (
    <div className="convo convo--chat term">
      {wide && <PcRail feeds={feeds} sessions={sessions} shown={shownPc} tone={tone} onPick={setPcKey} />}
      {(wide || active === null) && list}
      {view}
    </div>
  )
}
