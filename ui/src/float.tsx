import { listen } from '@tauri-apps/api/event'
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window'
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Alert, Limits, Pending, Session } from '../../shared/protocol.ts'
import { overallLink, useNow, useShell, useShownSession } from './App.tsx'
import { feedFor, limitsFor, merge, useFeeds } from './feeds.ts'
import { agentPose, Buddy, lookFor, type Tone, tintFor } from './buddy.tsx'
import { I18nContext, translator, type Translate } from './i18n.ts'
import { CheckIcon, XIcon } from './icons.tsx'
import { sendDecision } from './live.ts'
import { effortLabel, modelLabel } from './model.tsx'
import { KIND_LABEL, PendingHeadline } from './pending.tsx'
import { type Connection, readPref, windowsShell } from './platform.ts'
import { ON_OFF, usePref } from './prefs.ts'
import { playChime } from './sound.ts'
import { gauges } from './usage.tsx'

type EventKind = 'done' | 'error' | 'notice' | 'auto'

type EventBubble = {
  id: string
  kind: EventKind
  sessionName: string
  text: string
  until: number
}

// Moving further than this with the button down is a drag, not a click.
const DRAG_PX = 5
const DONE_MS = 9_000
const NOTICE_MS = 6_000
const MAX_EVENTS = 3
const MAX_AGENTS = 4

const EVENT_LABEL = {
  done: 'float.done',
  error: 'float.error',
  notice: 'float.notice',
  auto: 'float.auto',
} as const satisfies Record<EventKind, string>

function firstLine(text: string): string {
  return text.replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140)
}

function PendingBubble({ pending, more, connection, t }: { pending: Pending; more: number; connection: Connection; t: Translate }) {
  const [busy, setBusy] = useState(false)
  const question = pending.questions.length === 1 ? pending.questions[0] : undefined
  const quickOptions = question !== undefined && !question.multiSelect && question.options.length <= 4 ? question.options : null

  const decide = async (behavior: 'allow' | 'deny', answer: string | null): Promise<void> => {
    setBusy(true)
    await sendDecision(connection, {
      id: pending.id,
      behavior,
      message: null,
      answers: answer === null || question === undefined ? null : { [question.question]: answer },
    })
    setBusy(false)
  }

  return (
    <div className={`fb fb--pending fb--${pending.kind}`}>
      <div className="fb-kicker">
        {t(KIND_LABEL[pending.kind])} · {pending.sessionName}
        {more > 0 && <span className="fb-more">{t('float.more', { n: more })}</span>}
      </div>
      <div className="fb-text">
        <PendingHeadline pending={pending} />
      </div>
      <div className="fb-actions">
        {pending.kind === 'permission' && (
          <>
            <button type="button" className="fb-btn" disabled={busy} onClick={() => void decide('deny', null)}>
              <XIcon size={13} /> {t('action.deny')}
            </button>
            <button type="button" className="fb-btn fb-btn--go" disabled={busy} onClick={() => void decide('allow', null)}>
              <CheckIcon size={13} /> {t('action.allow')}
            </button>
          </>
        )}
        {pending.kind === 'question' &&
          (quickOptions === null ? (
            <button type="button" className="fb-btn fb-btn--go" onClick={() => void windowsShell.showMain()}>
              {t('action.open')}
            </button>
          ) : (
            quickOptions.map(option => (
              <button type="button" key={option.label} className="fb-btn" disabled={busy} title={option.description} onClick={() => void decide('allow', option.label)}>
                {option.label}
              </button>
            ))
          ))}
        {pending.kind === 'plan' && (
          <>
            <button type="button" className="fb-btn" onClick={() => void windowsShell.showMain()}>
              {t('action.open')}
            </button>
            <button type="button" className="fb-btn fb-btn--go" disabled={busy} onClick={() => void decide('allow', null)}>
              <CheckIcon size={13} /> {t('action.approve')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function ProgressBubble({ session, now, t }: { session: Session; now: number; t: Translate }) {
  const running = session.steps.findLast(step => step.status === 'running')
  const done = session.todos.filter(todo => todo.status === 'completed').length
  const total = session.todos.length
  const look = lookFor(session, 'live', now)

  return (
    <div className="fb fb--progress">
      <div className="fb-kicker">
        {session.name} · {t(look.label)}
      </div>
      {running !== undefined && (
        <div className="fb-text">
          <strong>{running.tool}</strong> · {running.title}
        </div>
      )}
      {total > 0 && (
        <div className="fb-progress">
          <span className="fb-progress-bar">
            <span className="fb-progress-fill" style={{ width: `${(done / total) * 100}%` }} />
          </span>
          <span className="fb-progress-text">
            {done}/{total}
          </span>
        </div>
      )}
    </div>
  )
}

function StatsBubble({ session, limits, now, t }: { session: Session | null; limits: Limits | null; now: number; t: Translate }) {
  const items = gauges(t, session?.usage ?? null, limits, now)
  const model = modelLabel(session?.usage?.model ?? null)
  const effort = session?.usage?.effort ?? null

  if (items.length === 0 && model === null) return null

  return (
    <div className="fb fb--stats">
      {model !== null && (
        <div className="fb-stat">
          <span className="fb-stat-label">{t('model.title')}</span>
          <span className="fb-stat-value">{model}</span>
          {effort !== null && <span className="fb-stat-hint">{effortLabel(t, effort)}</span>}
        </div>
      )}
      {items.map(item => (
        <div className="fb-stat" key={item.key}>
          <span className="fb-stat-label">{item.label}</span>
          <span className="fb-stat-value">{item.value}</span>
          {item.hint !== null && <span className="fb-stat-hint">{item.hint}</span>}
        </div>
      ))}
    </div>
  )
}

export function FloatApp() {
  const { theme, lang, sources } = useShell()
  const t = useMemo(() => translator(lang), [lang])
  const now = useNow()
  const [sound, setSound] = usePref('sound', ON_OFF, 'on')
  const [progressBubbles] = usePref('progressBubbles', ON_OFF, 'on')
  const [doneBubbles] = usePref('doneBubbles', ON_OFF, 'on')
  const [, setFloatPref] = usePref('float', ON_OFF, 'on')
  const [events, setEvents] = useState<EventBubble[]>([])
  const [hover, setHover] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const hit = useRef<HTMLDivElement>(null)
  const leaveCheck = useRef<number | null>(null)

  // WebView2 can report a mouseleave when the window resizes under a cursor
  // that never moved (the stats bubble growing the window did exactly that,
  // so it blinked). The OS cursor position decides instead.
  const cursorOverBuddy = async (): Promise<boolean> => {
    const element = hit.current

    if (element === null) return false

    const win = getCurrentWindow()
    const [cursor, origin, scale] = await Promise.all([cursorPosition(), win.innerPosition(), win.scaleFactor()])
    const rect = element.getBoundingClientRect()
    const x = (cursor.x - origin.x) / scale
    const y = (cursor.y - origin.y) / scale

    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  const stopLeaveCheck = (): void => {
    if (leaveCheck.current !== null) window.clearInterval(leaveCheck.current)
    leaveCheck.current = null
  }

  const onMouseEnter = (): void => {
    stopLeaveCheck()
    setHover(press.current === null)
  }

  const onMouseLeave = (): void => {
    stopLeaveCheck()
    leaveCheck.current = window.setInterval(() => {
      void cursorOverBuddy().then(
        over => {
          if (over) return
          stopLeaveCheck()
          setHover(false)
        },
        () => {
          stopLeaveCheck()
          setHover(false)
        },
      )
    }, 150)
  }

  useEffect(() => stopLeaveCheck, [])

  // Press and drag moves the window natively (the shell remembers where it
  // was dropped); press and release without moving opens the big window.
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button === 0) press.current = { x: event.screenX, y: event.screenY, dragging: false }
  }

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const start = press.current

    if (start === null || start.dragging || (event.buttons & 1) === 0) return
    if (Math.hypot(event.screenX - start.x, event.screenY - start.y) < DRAG_PX) return

    start.dragging = true
    setHover(false)
    void getCurrentWindow().startDragging()
  }

  const onPointerUp = (): void => {
    const start = press.current

    press.current = null
    if (start !== null && !start.dragging) void windowsShell.showMain()
  }

  // Off until turned on again from the tray menu or the settings; the main
  // window follows the shared preference.
  const hideFloat = (): void => {
    setFloatPref('off')
    void windowsShell.setFloat(false)
  }
  const tone: Tone = theme === 'dark' ? 'white' : 'black'

  useEffect(() => {
    document.documentElement.classList.add('is-float')

    // No WebView menu (Back, Save as…) anywhere on the buddy's window.
    const block = (event: MouseEvent): void => event.preventDefault()

    document.addEventListener('contextmenu', block)

    return () => document.removeEventListener('contextmenu', block)
  }, [])

  // What the buddy's own menu sends back; opening, moving and quitting are done by the shell.
  useEffect(() => {
    const unlisten = listen<string>('float-menu', event => {
      if (event.payload === 'hide') hideFloat()
      if (event.payload === 'sound') setSound(readPref('sound', ON_OFF, 'on') === 'on' ? 'off' : 'on')
    })

    return () => void unlisten.then(stop => stop())
  }, [])

  const openMenu = (): void => {
    void windowsShell.floatMenu({
      open: t('float.menuOpen'),
      sound: sound === 'on' ? t('float.menuSoundOff') : t('float.menuSoundOn'),
      reset: t('float.menuReset'),
      hide: t('float.menuHide'),
      quit: t('float.menuQuit'),
    })
  }

  const onAlert = useCallback(
    (alert: Alert) => {
      if (sound === 'on' && (alert.type === 'pending' || alert.type === 'done' || alert.type === 'error')) playChime(alert.type)
      if (alert.type === 'pending' || alert.type === 'resolved') return
      if (alert.type === 'done' && doneBubbles !== 'on') return

      const kind = alert.type === 'notice' ? 'notice' : alert.type
      const bubble: EventBubble = {
        id: `${alert.sessionId}-${alert.at}`,
        kind,
        sessionName: alert.sessionName,
        text: firstLine(alert.text),
        until: Date.now() + (kind === 'notice' || kind === 'auto' ? NOTICE_MS : DONE_MS),
      }

      setEvents(list => [...list.filter(item => item.id !== bubble.id), bubble].slice(-MAX_EVENTS))
    },
    [sound, doneBubbles],
  )

  const feeds = useFeeds(sources, onAlert)
  const merged = useMemo(() => merge(feeds), [feeds])
  const sessions = merged.sessions
  const current = useShownSession(sessions, null, now)
  const look = lookFor(current, sources.length === 0 ? 'connecting' : overallLink(feeds), now)
  const pending = merged.pending
  const agents = (current?.agents ?? []).filter(agent => agent.status === 'running').slice(0, MAX_AGENTS)
  const liveEvents = events.filter(item => item.until > now)
  const firstPending = pending[0]
  const pendingFeed = feedFor(feeds, firstPending?.pcKey)
  const autoAccept = feeds.some(feed => (feed.snapshot?.server.autoAcceptUntil ?? 0) > now)

  // The window hugs what is drawn, anchored to the bottom-right corner.
  useEffect(() => {
    const element = root.current

    if (element === null) return

    let last = ''
    let frame = 0
    // One resize per frame at most, and none when the size did not change.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const size = `${Math.ceil(element.offsetWidth)}x${Math.ceil(element.offsetHeight)}`

        if (size === last) return
        last = size
        void windowsShell.floatLayout(Math.ceil(element.offsetWidth), Math.ceil(element.offsetHeight))
      })
    })

    observer.observe(element)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  return (
    <I18nContext.Provider value={{ lang, t }}>
      <div className="float" ref={root}>
        <div className="fb-stack">
          {hover && <StatsBubble session={current} limits={limitsFor(merged, current)} now={now} t={t} />}
          {liveEvents.map(item => (
            <button type="button" key={item.id} className={`fb fb--${item.kind}`} onClick={() => void windowsShell.showMain()}>
              <span className="fb-kicker">
                {item.sessionName} · {t(EVENT_LABEL[item.kind])}
              </span>
              {item.text !== '' && <span className="fb-text">{item.text}</span>}
            </button>
          ))}
          {progressBubbles === 'on' && current?.status === 'working' && firstPending === undefined && <ProgressBubble session={current} now={now} t={t} />}
          {firstPending !== undefined && pendingFeed !== null && (
            <PendingBubble pending={firstPending} more={pending.length - 1} connection={pendingFeed.connection} t={t} />
          )}
        </div>
        <div className="float-row">
          {agents.map(agent => {
            const pose = agentPose(agent)

            return (
              <span className="float-agent" key={agent.id}>
                <Buddy pose={pose.pose} mood={pose.mood} tone={tone} tint={tintFor(agent.id)} size={30} />
              </span>
            )
          })}
          <div className="float-hit" ref={hit} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onContextMenu={openMenu}>
            <button
              type="button"
              className={`float-buddy ${firstPending !== undefined ? 'alert' : ''}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              aria-label="ChoiBuddy"
            >
              <Buddy pose={look.pose} mood={look.mood} tone={tone} size={64} />
              {autoAccept && <span className="float-auto">AUTO</span>}
            </button>
            {hover && (
              <button type="button" className="float-close" onClick={hideFloat} aria-label={t('float.hide')}>
                <XIcon size={11} />
              </button>
            )}
          </div>
        </div>
      </div>
    </I18nContext.Provider>
  )
}
