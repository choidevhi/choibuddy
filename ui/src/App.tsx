import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Alert, type BrowserRequest, type CommandInfo, type Decision, PROMPT_MODES, type PromptMode, type Session } from '../../shared/protocol.ts'
import { answerBrowserRequest, BrowserTab } from './browser.tsx'
import { type TermRequest, TerminalTab, useTerminalRequests } from './terminal.tsx'
import { type Feed, feedFor, loadSources, merge, type PcSession, type Source, useFeeds } from './feeds.ts'
import { useTailnetAutoConnect } from './autoconnect.ts'
import { closeTopLayer } from './back.ts'
import { UpdateSheet, useUpdate } from './update.tsx'
import { Buddy, type Tone } from './buddy.tsx'
import { Chat } from './chat.tsx'
import { Connect, type Prefs } from './connect.tsx'
import { Docs } from './docs.tsx'
import { Gallery } from './gallery.tsx'
import { HomeScreen } from './homescreen.tsx'
import { detectLang, I18nContext, type Lang, LANGS, translator } from './i18n.ts'
import {
  ChatIcon,
  DownloadIcon,
  FileTextIcon,
  GlobeIcon,
  HomeIcon,
  ImageIcon,
  MinusIcon,
  MoonIcon,
  MuteIcon,
  PinIcon,
  PlusIcon,
  ShieldIcon,
  SunIcon,
  TerminalIcon,
  VolumeIcon,
  XIcon,
} from './icons.tsx'
import { ConnectionContext, fetchCommands, type LinkState, sendDecision, sendPrompt, type Uploaded, uploadFile } from './live.ts'
import { NewSessionSheet } from './newsession.tsx'
import { PendingSheet } from './pending.tsx'
import { platform, readPref, windowsShell } from './platform.ts'
import { ON_OFF, usePref } from './prefs.ts'
import { playChime } from './sound.ts'

type Tab = 'home' | 'chat' | 'gallery' | 'browser' | 'terminal' | 'docs' | 'connect'

type Theme = 'dark' | 'light'

const THEMES = ['dark', 'light'] as const

const LANG_IDS = LANGS.map(lang => lang.id)

// Picking a session holds it this long; after that the view
// follows whichever session is busy.
const PIN_MS = 3 * 60_000

// Below this height a phone screen is treated as short (keyboard up).
const SHORT_BELOW_PX = 600

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })

  useEffect(() => {
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight })

    window.addEventListener('resize', onResize)

    return () => window.removeEventListener('resize', onResize)
  }, [])

  return size
}

// After a session finishes it stays on screen this long before the view
// moves to another one that is still working.
const LINGER_MS = 20_000

function isActive(session: Session): boolean {
  return session.status === 'thinking' || session.status === 'working' || session.status === 'waiting'
}

// Which session to show: the pinned one; else a session asking for an answer;
// else the one already shown while it works (and a little after); else
// another one at work. Several busy sessions no longer make the view hop to
// whichever reported last.
export function pickSession<T extends Session>(sessions: T[], pinnedId: string | null, shownId: string | null, now: number): T | null {
  const pinned = pinnedId === null ? undefined : sessions.find(session => session.id === pinnedId)

  if (pinned !== undefined) return pinned

  const shown = shownId === null ? undefined : sessions.find(session => session.id === shownId)

  if (shown?.status === 'waiting') return shown

  const waiting = sessions.find(session => session.status === 'waiting')

  if (waiting !== undefined) return waiting
  if (shown !== undefined && (isActive(shown) || now - shown.updatedAt < LINGER_MS)) return shown

  return sessions.find(isActive) ?? shown ?? sessions.find(session => session.status !== 'ended') ?? sessions[0] ?? null
}

// pickSession with memory of what is on screen.
export function useShownSession<T extends Session>(sessions: T[], pinnedId: string | null, now: number): T | null {
  const shownId = useRef<string | null>(null)
  const picked = pickSession(sessions, pinnedId, shownId.current, now)

  shownId.current = picked?.id ?? null

  return picked
}

// Shared by the widget and the floating buddy: theme, language, and the
// bridges to listen to (this PC's and any other PC paired in).
export function useShell(): {
  theme: Theme
  setTheme: (next: Theme) => void
  lang: Lang
  setLang: (next: Lang) => void
  sources: Source[]
  loaded: boolean
  reload: () => void
} {
  const [theme, setTheme] = usePref<Theme>('theme', THEMES, systemTheme())
  const [lang, setLang] = usePref<Lang>('lang', LANG_IDS, detectLang())
  const [sources, setSources] = useState<Source[]>([])
  const [loaded, setLoaded] = useState(false)

  const reload = useCallback(() => {
    void loadSources().then(next => {
      setSources(next)
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    reload()
    window.addEventListener('choibuddy-config', reload)

    return () => window.removeEventListener('choibuddy-config', reload)
  }, [reload])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.lang = lang
  }, [theme, lang])

  return { theme, setTheme, lang, setLang, sources, loaded, reload }
}

export function useNow(): number {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(timer)
  }, [])

  return now
}

// The most hopeful state across PCs: one live bridge is enough to show live.
export function overallLink(feeds: Feed[]): LinkState {
  if (feeds.some(feed => feed.link === 'live')) return 'live'
  if (feeds.length === 0 || feeds.some(feed => feed.link === 'connecting')) return 'connecting'

  return feeds.every(feed => feed.link === 'unauthorized') ? 'unauthorized' : 'offline'
}

export function App() {
  const { theme, setTheme, lang, setLang, sources, loaded, reload } = useShell()
  const t = useMemo(() => translator(lang), [lang])
  const [tab, setTab] = useState<Tab>('home')
  // Tabs to go back to, oldest first. Home is where back ends, so opening it
  // starts over.
  const [trail, setTrail] = useState<Tab[]>([])
  const [sound, setSound] = usePref('sound', ON_OFF, 'on')
  const [alwaysOnTop, setAlwaysOnTop] = usePref('alwaysOnTop', ON_OFF, 'off')
  const [revealOnRequest, setRevealOnRequest] = usePref('revealOnRequest', ON_OFF, 'on')
  const [keepScreenOn, setKeepScreenOn] = usePref('keepScreenOn', ON_OFF, 'off')
  const [float, setFloat] = usePref('float', ON_OFF, 'on')
  const [progressBubbles, setProgressBubbles] = usePref('progressBubbles', ON_OFF, 'on')
  const [doneBubbles, setDoneBubbles] = usePref('doneBubbles', ON_OFF, 'on')
  const [pin, setPin] = useState<{ id: string; at: number } | null>(null)
  const [chatId, setChatId] = useState<string | null>(null)
  const [later, setLater] = useState<ReadonlySet<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [newSession, setNewSession] = useState(false)
  // Command results from before the app opened are history, not news.
  const openedAt = useRef(Date.now())
  const seenCommands = useRef(new Set<string>())
  const now = useNow()
  const viewport = useViewport()
  const tone: Tone = theme === 'dark' ? 'white' : 'black'
  // On Windows the floating buddy speaks up (and chimes); the widget stays quiet.
  const floatOwnsAlerts = platform === 'windows' && float === 'on'

  const prefs: Prefs = {
    alwaysOnTop: alwaysOnTop === 'on',
    revealOnRequest: revealOnRequest === 'on',
    keepScreenOn: keepScreenOn === 'on',
    float: float === 'on',
    progressBubbles: progressBubbles === 'on',
    doneBubbles: doneBubbles === 'on',
  }

  const onPrefs = (next: Prefs): void => {
    const flag = (on: boolean): 'on' | 'off' => (on ? 'on' : 'off')

    setAlwaysOnTop(flag(next.alwaysOnTop))
    setRevealOnRequest(flag(next.revealOnRequest))
    setKeepScreenOn(flag(next.keepScreenOn))
    setFloat(flag(next.float))
    setProgressBubbles(flag(next.progressBubbles))
    setDoneBubbles(flag(next.doneBubbles))
  }

  useEffect(() => {
    const onToast = (event: Event): void => setToast(event instanceof CustomEvent && typeof event.detail === 'string' ? event.detail : null)

    window.addEventListener('choibuddy-toast', onToast)

    return () => window.removeEventListener('choibuddy-toast', onToast)
  }, [])

  useEffect(() => {
    if (toast === null) return

    const timer = window.setTimeout(() => setToast(null), 3500)

    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (platform === 'windows') void windowsShell.setAlwaysOnTop(alwaysOnTop === 'on')
  }, [alwaysOnTop])

  useEffect(() => {
    if (platform === 'windows') void windowsShell.setFloat(float === 'on')
  }, [float])

  useEffect(() => {
    if (platform === 'android') window.ChoiBuddyNative?.setKeepScreenOn(keepScreenOn === 'on')
  }, [keepScreenOn])

  useEffect(() => {
    if (platform === 'android') window.ChoiBuddyNative?.setLanguage?.(lang)
  }, [lang])

  useEffect(() => {
    if (platform === 'windows') void windowsShell.setTrayTexts(t('tray.open'), t('tray.showFloat'), t('tray.resetFloat'), t('tray.quit'))
  }, [t])

  // "Show floating buddy" in the tray turns the setting back on.
  useEffect(() => {
    if (platform !== 'windows') return

    const unlisten = listen('tray-float-on', () => setFloat('on'))

    return () => void unlisten.then(stop => stop())
  }, [])

  const hasLocal = sources.some(source => source.local)

  useEffect(() => {
    if (platform === 'windows' && hasLocal) void windowsShell.startBridge()
  }, [hasLocal])

  const onAlert = useCallback(
    (alert: Alert) => {
      if (alert.type === 'pending' && platform === 'windows' && revealOnRequest === 'on' && !floatOwnsAlerts) void windowsShell.reveal()
      if (sound !== 'on' || floatOwnsAlerts) return
      if (alert.type === 'pending') playChime('pending')
      if (alert.type === 'done') playChime('done')
      if (alert.type === 'error') playChime('error')
    },
    [sound, revealOnRequest, floatOwnsAlerts],
  )

  const onBrowserRequest = useCallback(
    (request: BrowserRequest, source: Source) => {
      if (platform === 'windows') void answerBrowserRequest(source.connection, request, t)
    },
    [t],
  )

  const feeds = useFeeds(sources, onAlert, onBrowserRequest)

  useTailnetAutoConnect(feeds, name => setToast(t('toast.autoConnected', { name })))

  const update = useUpdate()
  const [updating, setUpdating] = useState(false)
  const merged = useMemo(() => merge(feeds), [feeds])
  const sessions = merged.sessions
  const ordered = useMemo(() => [...sessions].sort((a, b) => a.startedAt - b.startedAt), [sessions])
  const pinnedId = pin !== null && now - pin.at < PIN_MS ? pin.id : null
  const current: PcSession | null = useShownSession(sessions, pinnedId, now)
  const link = overallLink(feeds)
  const pending = merged.pending
  const currentFeed = feedFor(feeds, current?.pcKey) ?? feeds[0] ?? null
  const localFeed = feeds.find(feed => feed.local) ?? null
  const shown = pending.find(item => !later.has(item.id)) ?? null
  const hiddenCount = pending.filter(item => later.has(item.id)).length
  const compact = viewport.width < 560 || viewport.height < 330
  // A phone with the keyboard up has roughly half its usual height.
  const short = viewport.width < 560 && viewport.height < SHORT_BELOW_PX

  const decide = async (decision: Decision): Promise<'ok' | 'gone' | 'failed'> => {
    const target = feedFor(feeds, pending.find(item => item.id === decision.id)?.pcKey)

    if (target === null) return 'failed'

    const result = await sendDecision(target.connection, decision)

    if (result === 'ok') setToast(decision.behavior === 'deny' ? t('toast.denied') : t('toast.sent'))

    return result
  }

  const onSend = async (sessionId: string, text: string, mode?: PromptMode): Promise<boolean> => {
    const target = feedFor(feeds, sessions.find(session => session.id === sessionId)?.pcKey)

    if (target === null) return false

    // Read now: the setting may have changed in this window since mount.
    const result = await sendPrompt(target.connection, sessionId, text, mode ?? readPref('promptMode', PROMPT_MODES, 'steer'))

    setToast(result === 'queued' ? t('toast.promptQueued') : result === 'no-mod' ? t('toast.promptNoMod') : t('toast.promptFailed'))

    return result === 'queued'
  }

  const loadCommands = async (sessionId: string): Promise<CommandInfo[]> => {
    const target = feedFor(feeds, sessions.find(session => session.id === sessionId)?.pcKey)

    return target === null ? [] : fetchCommands(target.connection, sessionId)
  }

  // A slash command sent from here reports what it printed: say it briefly.
  useEffect(() => {
    for (const result of sessions.flatMap(session => session.commandLog)) {
      if (seenCommands.current.has(result.id)) continue
      seenCommands.current.add(result.id)
      if (result.at < openedAt.current) continue

      const line = result.text.split('\n').find(part => part.trim() !== '')?.trim() ?? ''

      setToast(`/${result.command}${line === '' ? '' : ` · ${line.slice(0, 80)}`}`)
    }
  }, [sessions])

  const onUpload = async (sessionId: string, file: File): Promise<Uploaded | null> => {
    const target = feedFor(feeds, sessions.find(session => session.id === sessionId)?.pcKey)
    const result = target === null ? null : await uploadFile(target.connection, sessionId, file)

    if (result === null) setToast(t('chat.uploadFailed', { name: file.name }))

    return result
  }

  const installBridge = async (): Promise<void> => {
    setInstalling(true)

    const ok = await windowsShell.installBridge().catch(() => false)

    setInstalling(false)
    setToast(ok ? t('toast.installed') : t('toast.installFailed'))
    reload()
  }

  const toggleSound = (): void => {
    const next = sound === 'on' ? 'off' : 'on'

    setSound(next)
    if (next === 'on') playChime('done')
  }

  const needsSetup = loaded && sources.length === 0
  const autoAccept = feeds.some(feed => (feed.snapshot?.server.autoAcceptUntil ?? 0) > now)
  const activeTab: Tab = needsSetup && platform === 'android' ? 'connect' : tab

  // A terminal asked for elsewhere (session list, menu, new session) opens in the terminal tab.
  const [termRequest, setTermRequest] = useState<(TermRequest & { at: number }) | null>(null)

  useTerminalRequests(request => {
    setTermRequest({ ...request, at: Date.now() })
    openTab('terminal')
  })

  const openTab = (next: Tab): void => {
    if (next === tab) return

    setTrail(next === 'home' ? [] : [...trail.filter(item => item !== next), tab])
    setTab(next)
  }

  // Ctrl+PageUp / Ctrl+PageDown step through the tabs, as in a browser.
  useEffect(() => {
    const tabs: Tab[] = platform === 'windows' ? ['home', 'chat', 'gallery', 'browser', 'terminal', 'docs', 'connect'] : ['home', 'chat', 'gallery', 'terminal', 'docs', 'connect']

    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || (event.key !== 'PageUp' && event.key !== 'PageDown')) return
      event.preventDefault()

      const at = Math.max(0, tabs.indexOf(activeTab))
      const next = tabs[(at + (event.key === 'PageDown' ? 1 : tabs.length - 1)) % tabs.length]

      if (next !== undefined) openTab(next)
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  })

  // The phone's back button: close what is open, then go to the previous tab.
  // On home (or the first-run setup) there is nothing left, and the app goes.
  useEffect(() => {
    window.choibuddyBack = (): boolean => {
      if (closeTopLayer()) return true
      if (activeTab !== tab || tab === 'home') return false

      setTrail(trail.slice(0, -1))
      setTab(trail.at(-1) ?? 'home')

      return true
    }

    return () => {
      window.choibuddyBack = undefined
    }
  }, [tab, trail, activeTab])

  return (
    <I18nContext.Provider value={{ lang, t }}>
      <ConnectionContext.Provider value={currentFeed?.connection ?? null}>
        <div className={`app app--${platform}`}>
          <header className="topbar" data-tauri-drag-region>
            <nav className="tabs">
              <button type="button" className={activeTab === 'home' ? 'on' : ''} onClick={() => openTab('home')} title={t('tab.home')}>
                <HomeIcon size={17} />
              </button>
              <button type="button" className={activeTab === 'chat' ? 'on' : ''} onClick={() => openTab('chat')} title={t('tab.chat')}>
                <ChatIcon size={17} />
              </button>
              <button type="button" className={activeTab === 'gallery' ? 'on' : ''} onClick={() => openTab('gallery')} title={t('tab.gallery')}>
                <ImageIcon size={17} />
              </button>
              {platform === 'windows' && (
                <button type="button" className={activeTab === 'browser' ? 'on' : ''} onClick={() => openTab('browser')} title={t('tab.browser')}>
                  <GlobeIcon size={17} />
                </button>
              )}
              <button type="button" className={activeTab === 'terminal' ? 'on' : ''} onClick={() => openTab('terminal')} title={t('tab.terminal')}>
                <TerminalIcon size={17} />
              </button>
              <button type="button" className={activeTab === 'docs' ? 'on' : ''} onClick={() => openTab('docs')} title={t('tab.docs')}>
                <FileTextIcon size={17} />
              </button>
              <button type="button" className={activeTab === 'connect' ? 'on' : ''} onClick={() => openTab('connect')} title={t('tab.connect')}>
                <PlusIcon size={17} />
              </button>
            </nav>

            <div className="dots" data-tauri-drag-region />

            {hiddenCount > 0 && shown === null && (
              <button type="button" className="pending-badge" onClick={() => setLater(new Set())}>
                <ShieldIcon size={14} /> {t('badge.pending', { n: hiddenCount })}
              </button>
            )}

            {update.release !== null && (
              <button type="button" className="update-badge" onClick={() => setUpdating(true)} title={t('update.title', { v: update.release.version })}>
                <DownloadIcon size={14} /> <span className="update-badge-text">{t('update.badge', { v: update.release.version })}</span>
              </button>
            )}

            {autoAccept && (
              <button type="button" className="auto-badge" onClick={() => openTab('connect')} aria-label={t('badge.auto')}>
                <ShieldIcon size={14} /> <span className="auto-badge-text">{t('badge.auto')}</span>
              </button>
            )}

            <div className="tools">
              <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={t('tool.theme')}>
                {theme === 'dark' ? <SunIcon size={17} /> : <MoonIcon size={17} />}
              </button>
              <button type="button" onClick={toggleSound} title={t('tool.sound')}>
                {sound === 'on' ? <VolumeIcon size={17} /> : <MuteIcon size={17} />}
              </button>
              {platform === 'windows' && (
                <>
                  <button type="button" className={alwaysOnTop === 'on' ? 'on-soft' : ''} onClick={() => setAlwaysOnTop(alwaysOnTop === 'on' ? 'off' : 'on')} title={t('tool.pin')}>
                    <PinIcon size={15} />
                  </button>
                  <button type="button" onClick={() => void windowsShell.minimize()} title={t('tool.minimize')}>
                    <MinusIcon size={16} />
                  </button>
                  <button type="button" onClick={() => void windowsShell.hide()} title={t('tool.hide')}>
                    <XIcon size={16} />
                  </button>
                </>
              )}
            </div>
          </header>

          <main className="content">
            {needsSetup && platform !== 'android' ? (
              <div className="setup">
                <Buddy pose="wave" mood="happy" tone={tone} size={96} />
                <div className="empty-title">{t('setup.title')}</div>
                {platform === 'windows' ? (
                  <>
                    <div className="empty-sub">{t('setup.windows')}</div>
                    <button type="button" className="btn btn--allow" disabled={installing} onClick={() => void installBridge()}>
                      {installing ? t('setup.installing') : t('setup.button')}
                    </button>
                  </>
                ) : (
                  <div className="empty-sub">{t('setup.web')}</div>
                )}
              </div>
            ) : activeTab === 'home' ? (
              <HomeScreen
                feeds={feeds}
                streams={merged.streams}
                sessions={ordered}
                limits={merged.limits}
                auto={current}
                link={sources.length === 0 ? 'connecting' : link}
                tone={tone}
                now={now}
                compact={compact}
                short={short}
                onSend={onSend}
                onUpload={onUpload}
                loadCommands={loadCommands}
                onNewSession={() => setNewSession(true)}
                onOpenChat={sessionId => {
                  setChatId(sessionId)
                  openTab('chat')
                }}
              />
            ) : activeTab === 'chat' ? (
              <Chat
                streams={merged.streams}
                feeds={feeds}
                multiPc={merged.multiPc}
                sessions={ordered}
                selectedId={chatId ?? current?.id ?? null}
                onSelect={(id, live) => {
                  setChatId(id)
                  if (live) setPin({ id, at: Date.now() })
                }}
                tone={tone}
                now={now}
                onSend={onSend}
                onUpload={onUpload}
                loadCommands={loadCommands}
                onNewSession={() => setNewSession(true)}
              />
            ) : activeTab === 'gallery' ? (
              <Gallery feeds={feeds} sessions={ordered} latestAt={merged.galleryLatest} now={now} tone={tone} />
            ) : activeTab === 'browser' ? (
              <BrowserTab session={current} onSend={onSend} onUpload={onUpload} loadCommands={loadCommands} />
            ) : activeTab === 'terminal' ? (
              <TerminalTab feeds={feeds} sessions={ordered} tone={tone} dark={theme === 'dark'} request={termRequest} />
            ) : activeTab === 'docs' ? (
              <Docs feeds={feeds} sessions={ordered} tone={tone} />
            ) : (
              <Connect feeds={feeds} now={now} localFeed={localFeed} prefs={prefs} onPrefs={onPrefs} onLang={setLang} onSourcesChanged={reload} update={update} onUpdate={() => setUpdating(true)} />
            )}
          </main>

          {shown !== null && (
            <PendingSheet
              pending={shown}
              count={pending.length}
              cwd={sessions.find(session => session.id === shown.sessionId)?.cwd ?? ''}
              tone={tone}
              onDecide={decide}
              onLater={() => setLater(current => new Set([...current, shown.id]))}
            />
          )}

          {newSession && <NewSessionSheet feeds={feeds} preferredKey={current?.pcKey ?? null} onClose={() => setNewSession(false)} />}

          {updating && update.release !== null && <UpdateSheet release={update.release} onClose={() => setUpdating(false)} />}

          {toast !== null && <div className="toast">{toast}</div>}
        </div>
      </ConnectionContext.Provider>
    </I18nContext.Provider>
  )
}
