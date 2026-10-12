import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import type { BrowserRequest, Session } from '../../shared/protocol.ts'
import { useOverlayOpen } from './back.ts'
import { type CommandsFn, Composer, type Injection, type UploadFn } from './chat.tsx'
import { showToast } from './confirm.tsx'
import { type Translate, useI18n } from './i18n.ts'
import { ArrowLeftIcon, ArrowRightIcon, CameraIcon, CrosshairIcon, GlobeIcon, RotateIcon, XIcon } from './icons.tsx'
import { answerBrowser } from './live.ts'
import type { Connection } from './platform.ts'

type Rect = { x: number; y: number; width: number; height: number }

// What the page sends back when an element is picked (browser.rs).
export type Picked = {
  url: string
  title: string
  selector: string
  tag: string
  text: string
  html: string
  rect: Rect
}

// Shared with the answer to Claude's browser_view call, which can come while
// another tab is showing.
const state: { open: boolean; url: string; picked: Picked | null } = { open: false, url: '', picked: null }

const PICK_PADDING = 12

// With this app's browser closed, another PC's ChoiBuddy may have one open
// for the session: it gets this head start before this app says no.
const CLOSED_ANSWER_DELAY_MS = 3000

function pngFile(base64: string, name: string): File {
  return new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], name, { type: 'image/png' })
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19).replace(/:/g, '')
}

// The picked element as Claude reads it.
export function pickedText(picked: Picked): string {
  const lines = [`Element I picked in the ChoiBuddy browser (${picked.url}):`, `- selector: \`${picked.selector}\``]

  if (picked.text.trim() !== '') lines.push(`- text: ${picked.text.trim()}`)
  lines.push('```html', picked.html, '```')

  return lines.join('\n')
}

// Answers Claude's browser_view: the address, a screenshot, the picked element.
export async function answerBrowserRequest(connection: Connection, request: BrowserRequest, t: Translate): Promise<void> {
  if (!state.open) await new Promise<void>(resolve => setTimeout(resolve, CLOSED_ANSWER_DELAY_MS))

  if (!state.open) {
    await answerBrowser(connection, request.id, { ok: false, error: 'The ChoiBuddy browser is not open. Ask the person to open the Browser tab in ChoiBuddy and load the page.' })

    return
  }

  const [image, current] = await Promise.all([
    invoke<string>('browser_capture', { rect: null }).catch(() => null),
    invoke<{ url: string } | null>('browser_state').catch(() => null),
  ])

  const taken = await answerBrowser(connection, request.id, {
    ok: true,
    url: current?.url ?? state.url,
    title: state.picked?.title ?? '',
    picked: state.picked === null ? null : pickedText(state.picked),
    image,
  })

  // Another app may have answered first.
  if (taken) showToast(t('browser.claudeLooked'))
}

type Props = {
  session: Session | null
  onSend: (sessionId: string, text: string) => Promise<boolean>
  onUpload: UploadFn
  loadCommands: CommandsFn
}

// A browser inside the widget (Windows). The page is a native webview laid
// over `page`; the bar above drives it. Picking an element or attaching the
// screen puts it into the prompt box below, for the session on the stage.
export function BrowserTab({ session, onSend, onUpload, loadCommands }: Props) {
  const { t } = useI18n()
  // A sheet, menu or viewer is over the window: the page must not cover it.
  const covered = useOverlayOpen()
  const [address, setAddress] = useState(state.url)
  const [url, setUrl] = useState(state.url)
  const [editing, setEditing] = useState(false)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(state.picked)
  const [inject, setInject] = useState<Injection | null>(null)
  const page = useRef<HTMLDivElement>(null)

  const bounds = (): Rect | null => {
    const rect = page.current?.getBoundingClientRect()

    return rect === undefined ? null : { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  // Keep the webview on the page area as the window and layout change.
  useEffect(() => {
    const element = page.current

    if (element === null) return

    const place = (): void => {
      const next = bounds()

      if (state.open && next !== null) void invoke('browser_set_bounds', { bounds: next }).catch(() => undefined)
    }
    const observer = new ResizeObserver(place)

    observer.observe(element)
    window.addEventListener('resize', place)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [])

  // Shown while this tab is, and nothing covers the window.
  useEffect(() => {
    if (!state.open) return

    void invoke('browser_set_visible', { visible: !covered }).catch(() => undefined)
  }, [covered])

  useEffect(() => {
    if (state.open) {
      const next = bounds()

      if (next !== null) void invoke('browser_set_bounds', { bounds: next }).catch(() => undefined)
      void invoke('browser_set_visible', { visible: true }).catch(() => undefined)
    }

    return () => {
      if (state.open) void invoke('browser_set_visible', { visible: false }).catch(() => undefined)
      void invoke('browser_pick', { on: false }).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const unlisten = [
      listen<{ url: string }>('browser-navigated', event => {
        state.url = event.payload.url
        setUrl(event.payload.url)
      }),
      listen<Picked>('browser-picked', event => {
        state.picked = event.payload
        setPicked(event.payload)
        setPicking(false)
      }),
      listen('browser-pick-cancel', () => setPicking(false)),
    ]

    return () => {
      for (const done of unlisten) void done.then(stop => stop())
    }
  }, [])

  useEffect(() => {
    if (!editing) setAddress(url)
  }, [url, editing])

  const go = async (): Promise<void> => {
    const target = address.trim()
    const next = bounds()

    if (target === '' || next === null) return

    try {
      const loaded = await invoke<string>(state.open ? 'browser_navigate' : 'browser_open', state.open ? { url: target } : { url: target, bounds: next })

      state.open = true
      state.url = loaded
      setUrl(loaded)
      setEditing(false)
      state.picked = null
      setPicked(null)
    } catch {
      showToast(t('browser.invalidUrl'))
    }
  }

  const togglePick = (): void => {
    const on = !picking

    setPicking(on)
    void invoke('browser_pick', { on }).catch(() => setPicking(false))
  }

  const attachScreen = async (): Promise<void> => {
    const image = await invoke<string>('browser_capture', { rect: null }).catch(() => null)

    if (image === null) {
      showToast(t('browser.failed'))

      return
    }

    setInject({ id: Date.now(), text: `Screenshot of ${url} from the ChoiBuddy browser:`, files: [pngFile(image, `browser-${stamp()}.png`)] })
  }

  const addPicked = async (): Promise<void> => {
    if (picked === null) return

    const area = page.current?.getBoundingClientRect()
    const rect =
      area === undefined
        ? null
        : {
            x: Math.max(0, picked.rect.x - PICK_PADDING),
            y: Math.max(0, picked.rect.y - PICK_PADDING),
            width: Math.min(area.width, picked.rect.width + PICK_PADDING * 2),
            height: Math.min(area.height, picked.rect.height + PICK_PADDING * 2),
          }
    const image = await invoke<string>('browser_capture', { rect }).catch(() => null)

    setInject({ id: Date.now(), text: pickedText(picked), files: image === null ? [] : [pngFile(image, `element-${stamp()}.png`)] })
  }

  return (
    <div className="browser">
      <div className="browser-bar">
        <button type="button" className="icon-btn" disabled={!state.open} onClick={() => void invoke('browser_go', { action: 'back' })} title={t('browser.back')}>
          <ArrowLeftIcon size={16} />
        </button>
        <button type="button" className="icon-btn" disabled={!state.open} onClick={() => void invoke('browser_go', { action: 'forward' })} title={t('browser.forward')}>
          <ArrowRightIcon size={16} />
        </button>
        <button type="button" className="icon-btn" disabled={!state.open} onClick={() => void invoke('browser_go', { action: 'reload' })} title={t('browser.reload')}>
          <RotateIcon size={15} />
        </button>
        <input
          className="field browser-address"
          value={address}
          placeholder={t('browser.urlPlaceholder')}
          spellCheck={false}
          onFocus={event => {
            setEditing(true)
            event.target.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={event => setAddress(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void go()
            if (event.key === 'Escape') {
              setAddress(url)
              event.currentTarget.blur()
            }
          }}
        />
        <button type="button" className={`btn small ${picking ? 'btn--danger' : ''}`} disabled={!state.open} onClick={togglePick}>
          <CrosshairIcon size={14} /> {t('browser.pick')}
        </button>
        <button type="button" className="btn small" disabled={!state.open} onClick={() => void attachScreen()}>
          <CameraIcon size={14} /> {t('browser.capture')}
        </button>
      </div>

      {picking && <div className="browser-hint">{t('browser.picking')}</div>}

      {picked !== null && !picking && (
        <div className="browser-picked">
          <span className="browser-picked-label">{t('browser.picked')}</span>
          <code className="browser-picked-selector" title={picked.selector}>
            {picked.selector}
          </code>
          <span className="browser-picked-text">{picked.text}</span>
          <button type="button" className="btn small btn--allow" disabled={session === null} onClick={() => void addPicked()}>
            {t('browser.addToPrompt')}
          </button>
        </div>
      )}

      <div className="browser-page" ref={page}>
        {!state.open && (
          <div className="empty">
            <GlobeIcon size={28} className="dim" />
            <div className="empty-title">{t('browser.empty')}</div>
            <div className="empty-sub">{t('browser.emptySub')}</div>
          </div>
        )}
      </div>

      <Composer session={session} onSend={onSend} onUpload={onUpload} loadCommands={loadCommands} inject={inject} compact />
    </div>
  )
}

type PaneProps = Props & {
  // The session's name, shown in the head.
  title: string
  onClose: () => void
}

// The browser as a pane beside a session (Windows), working for that session.
export function BrowserPane({ title, onClose, ...props }: PaneProps) {
  const { t } = useI18n()

  return (
    <section className="convo-main pane browser-pane">
      <header className="pane-head">
        <GlobeIcon size={15} className="dim" />
        <span className="pane-title">
          <span className="pane-name">{t('tab.browser')}</span>
          <span className="pane-meta">{title}</span>
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t('chat.closePane')} title={t('chat.closePane')}>
          <XIcon size={15} />
        </button>
      </header>
      <BrowserTab {...props} />
    </section>
  )
}
