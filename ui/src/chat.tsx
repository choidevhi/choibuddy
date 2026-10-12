import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type ChatMessage, type CommandInfo, type Conversation, type GalleryImage, type LiveStream, PROMPT_MODES, type PromptMode, type QueuedItem, type Session } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { BrowserPane } from './browser.tsx'
import { Buddy, type Tone } from './buddy.tsx'
import { ConfirmSheet, showToast } from './confirm.tsx'
import { type MessageKey, useI18n } from './i18n.ts'
import { type Feed, feedFor, type PcSession } from './feeds.ts'
import { ChevronDownIcon, ClipboardIcon, DownloadIcon, GlobeIcon, PaperclipIcon, SpinnerIcon, SplitDownIcon, SplitIcon, TrashIcon, XIcon } from './icons.tsx'
import { readDraft, saveDraft } from './drafts.ts'
import { clipboardImageFile, RemoteImage, saveImage } from './images.tsx'
import { deleteConversation, fetchConversation, fetchGallery, reloadPlugins, type Uploaded } from './live.ts'
import { Markdown } from './markdown.tsx'
import { arrived, type OutPrompt, outPrompt, type Queued, syncOutbox } from './outbox.ts'
import { type PcEntry, useSessionNav } from './sessions.tsx'
import { closeLeaf, forgetSession, leavesOf, MAX_TILES, openBrowserBeside, sessionLeavesOf, setLeafSession, splitLeaf, type TileLeaf, TileView, useTiles, useWide } from './tiles.tsx'
import { Picker } from './picker.tsx'
import { platform, readPref } from './platform.ts'
import { useTypewriter } from './typewriter.ts'

const PAGE = 150

type TimelineItem = { message: ChatMessage } | { image: GalleryImage }

// Messages in transcript order with each picture placed before the first
// message that came after it; newer pictures go at the end. Pictures older
// than the first loaded message wait until older messages are loaded.
export function withPictures(messages: ChatMessage[], pictures: GalleryImage[], fromStart: boolean): TimelineItem[] {
  const first = messages[0]?.at ?? 0
  const pending = pictures.filter(image => fromStart || image.at >= first)
  const items: TimelineItem[] = []
  let next = 0

  for (const message of messages) {
    while (next < pending.length && (pending[next]?.at ?? 0) < message.at) {
      const image = pending[next]

      if (image !== undefined) items.push({ image })
      next += 1
    }

    items.push({ message })
  }

  for (const image of pending.slice(next)) items.push({ image })

  return items
}
// How long a finished reply waits on screen for the transcript to catch up.
const HOLD_REPLY_MS = 20_000
const MAX_SUGGESTIONS = 8

export type UploadFn = (sessionId: string, file: File) => Promise<Uploaded | null>

export type CommandsFn = (sessionId: string) => Promise<CommandInfo[]>

// Sends a prompt; `mode` overrides the setting for this one message.
export type SendFn = (sessionId: string, text: string, mode?: PromptMode) => Promise<boolean>

const MODE_LABEL = {
  steer: 'mode.steer',
  queue: 'mode.queue',
  interrupt: 'mode.interrupt',
} as const satisfies Record<PromptMode, MessageKey>

const QUEUED_LABEL = {
  steer: 'queued.steer',
  queue: 'queued.queue',
  interrupt: 'queued.interrupt',
  command: 'queued.command',
} as const satisfies Record<QueuedItem['mode'], MessageKey>

// Text and files another part of the app hands to the prompt box (the
// browser's picked element and screenshots). A new `id` means new content.
export type Injection = {
  id: number
  text: string
  files: File[]
}

type Attachment = {
  key: string
  name: string
  path: string | null
  failed: boolean
}

type ComposerProps = {
  session: Session | null
  onSend: SendFn
  onUpload: UploadFn
  loadCommands: CommandsFn
  inject?: Injection | null
  compact?: boolean
  // Called once a prompt went out (with how it was to meet a running turn),
  // so the conversation can show it at once and jump to the bottom.
  onSent?: (text: string, mode: PromptMode | null) => void
}

// Claude Code takes no files from a plugin's prompt, so attachments are
// uploaded to the session's PC and the prompt lists their paths for Claude
// to open.
export function attachmentNote(paths: string[]): string {
  return paths.length === 0 ? '' : `\n\nAttached files (open them with the Read tool):\n${paths.map(path => `- ${path}`).join('\n')}`
}

// Commands whose name starts with what was typed come first, then the ones
// that merely contain it.
export function suggestCommands(commands: CommandInfo[], typed: string): CommandInfo[] {
  const query = typed.toLowerCase()
  const starts: CommandInfo[] = []
  const contains: CommandInfo[] = []

  for (const command of commands) {
    const name = command.name.toLowerCase()

    if (name.startsWith(query)) starts.push(command)
    else if (query !== '' && name.includes(query)) contains.push(command)
  }

  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS)
}

// The prompt box, shared by the chat tab, the home screen and the browser.
// Enter sends, Shift+Enter breaks the line, IME composition is left alone.
// Files come in through the clip button, pasting, or dropping them on the
// box (on the phone also the clipboard button). Typing "/" offers the
// session's slash commands.
export function Composer({ session, onSend, onUpload, loadCommands, inject = null, compact = false, onSent }: ComposerProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [commands, setCommands] = useState<{ sessionId: string; list: CommandInfo[] } | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  // How this message meets a running turn; starts from the setting.
  const [mode, setMode] = useState<PromptMode>(() => readPref('promptMode', PROMPT_MODES, 'steer'))
  const picker = useRef<HTMLInputElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const ready = session !== null && session.status !== 'ended' && session.canPrompt
  const busy = ready && (session.status === 'working' || session.status === 'thinking' || session.status === 'waiting')
  const uploading = files.some(file => file.path === null && !file.failed)
  const paths = files.flatMap(file => (file.path === null ? [] : [file.path]))
  const text = `${draft.trim()}${attachmentNote(paths)}`.trim()
  const slash = /^\/(\S*)$/.exec(draft)
  const query = slash === null ? null : (slash[1] ?? '')
  const typing = ready && session.canCommand && query !== null && !dismissed
  const suggestions = typing && query !== null && commands?.sessionId === session.id ? suggestCommands(commands.list, query) : []
  const canClipboard = platform === 'android' && window.ChoiBuddyNative?.clipboardImage !== undefined
  const sessionId = session?.id ?? null
  // What the box holds and for which session, read by the handlers below.
  const held = useRef<{ sessionId: string | null; text: string; files: Attachment[] }>({ sessionId: null, text: '', files: [] })

  // Every change is kept for the session it was made in, so leaving the
  // session loses nothing. Saved where the change happens, never from an
  // effect that could run with an older box.
  const keep = (text: string, list: Attachment[]): void => {
    const owner = held.current.sessionId

    held.current = { sessionId: owner, text, files: list }
    if (owner !== null) saveDraft(owner, text, list.flatMap(file => (file.path === null || file.failed ? [] : [{ name: file.name, path: file.path }])))
  }

  const changeDraft = (text: string): void => {
    setDraft(text)
    keep(text, held.current.files)
  }

  const changeFiles = (list: Attachment[]): void => {
    setFiles(list)
    keep(held.current.text, list)
  }

  // The box belongs to the session: its words and finished uploads come back with it.
  useEffect(() => {
    const stored = sessionId === null ? null : readDraft(sessionId)
    const list = (stored?.files ?? []).map(file => ({ key: crypto.randomUUID(), name: file.name, path: file.path, failed: false }))

    held.current = { sessionId, text: stored?.text ?? '', files: list }
    setDraft(stored?.text ?? '')
    setFiles(list)
    setDismissed(false)
  }, [sessionId])

  useBackLayer(suggestions.length > 0, () => setDismissed(true))

  // The list is fetched once per session, when "/" is first typed.
  useEffect(() => {
    if (!typing || commands?.sessionId === session.id) return

    const sessionId = session.id

    void loadCommands(sessionId).then(list => setCommands({ sessionId, list }))
  }, [typing, session?.id])

  useEffect(() => setHighlight(0), [draft])

  const attach = (list: File[]): void => {
    if (!ready) return

    for (const file of list) {
      const key = crypto.randomUUID()
      const owner = held.current.sessionId

      changeFiles([...held.current.files, { key, name: file.name === '' ? 'pasted.png' : file.name, path: null, failed: false }])
      void onUpload(session.id, file).then(result => {
        // The box moved on to another session meanwhile.
        if (held.current.sessionId !== owner) return
        changeFiles(held.current.files.map(item => (item.key === key ? { ...item, path: result?.path ?? null, failed: result === null } : item)))
      })
    }
  }

  // What the browser hands over lands in the box, ready to add words to.
  useEffect(() => {
    if (inject === null) return

    changeDraft(held.current.text.trim() === '' ? inject.text : `${held.current.text.trimEnd()}\n\n${inject.text}`)
    attach(inject.files)
    input.current?.focus()
  }, [inject?.id])

  const pasteClipboard = (): void => {
    const file = clipboardImageFile()

    if (file === null) showToast(t('chat.clipboardEmpty'))
    else attach([file])
  }

  const send = async (): Promise<void> => {
    if (!ready || text === '' || sending || uploading) return

    setSending(true)

    const owner = session.id
    const sentText = text
    const sentMode = busy ? mode : null
    const ok = await onSend(owner, sentText, sentMode ?? undefined)

    setSending(false)

    // Sent: the session's draft is done, even when the box moved on meanwhile.
    if (ok && held.current.sessionId !== owner) saveDraft(owner, '', [])

    if (ok && held.current.sessionId === owner) {
      setDraft('')
      setFiles([])
      keep('', [])
      setDismissed(false)
      setMode(readPref('promptMode', PROMPT_MODES, 'steer'))
      onSent?.(sentText, sentMode)
    }
  }

  const complete = (command: CommandInfo): void => {
    changeDraft(`/${command.name} `)
    input.current?.focus()
  }

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return

    if (suggestions.length > 0) {
      const chosen = suggestions[highlight]

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight(index => (index + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)

        return
      }

      if ((event.key === 'Tab' || event.key === 'Enter') && chosen !== undefined && `/${chosen.name}` !== draft.trim()) {
        event.preventDefault()
        complete(chosen)

        return
      }

      if (event.key === 'Escape') {
        setDismissed(true)

        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div
      className={`composer-wrap ${dragging ? 'dragging' : ''}`}
      onDragOver={event => {
        if (!ready) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault()
        setDragging(false)
        attach(Array.from(event.dataTransfer.files))
      }}
    >
      {suggestions.length > 0 && (
        <div className="commands" role="listbox" aria-label={t('chat.commands')}>
          {suggestions.map((command, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === highlight}
              key={command.name}
              className={`command ${index === highlight ? 'on' : ''}`}
              onMouseDown={event => event.preventDefault()}
              onClick={() => complete(command)}
            >
              <span className="command-name">/{command.name}</span>
              <span className="command-desc">{command.description}</span>
            </button>
          ))}
        </div>
      )}
      {busy && (
        <div className="composer-mode" title={t('settings.promptModeHint')}>
          <span className="composer-mode-label">{t('mode.label')}</span>
          <Picker
            className="composer-mode-select"
            value={mode}
            title={t('settings.promptMode')}
            options={PROMPT_MODES.map(item => ({ value: item, label: t(MODE_LABEL[item]) }))}
            onChange={setMode}
          />
        </div>
      )}
      {files.length > 0 && (
        <div className="attachments">
          {files.map(file => (
            <span key={file.key} className={`chip ${file.failed ? 'chip--failed' : ''}`} title={file.failed ? t('chat.uploadFailed', { name: file.name }) : (file.path ?? file.name)}>
              {file.path === null && !file.failed ? <SpinnerIcon size={12} /> : <PaperclipIcon size={12} />}
              <span className="chip-name">{file.name}</span>
              <button type="button" className="chip-remove" onClick={() => changeFiles(held.current.files.filter(item => item.key !== file.key))} aria-label="×">
                <XIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={`composer ${compact ? 'composer--compact' : ''}`}>
        <button type="button" className="icon-btn attach-btn" disabled={!ready} onClick={() => picker.current?.click()} title={t('chat.attach')}>
          <PaperclipIcon size={17} />
        </button>
        {canClipboard && (
          <button type="button" className="icon-btn attach-btn" disabled={!ready} onClick={pasteClipboard} title={t('chat.clipboard')}>
            <ClipboardIcon size={17} />
          </button>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={event => {
            if (event.target.files !== null) attach(Array.from(event.target.files))
            event.target.value = ''
          }}
        />
        <textarea
          ref={input}
          className="field composer-input"
          rows={1}
          disabled={!ready}
          placeholder={dragging ? t('chat.dropHint') : ready ? t('chat.placeholder') : session === null || session.status === 'ended' ? t('chat.pastSession') : t('chat.noMod')}
          title={ready ? undefined : t('chat.noMod')}
          value={draft}
          onChange={event => {
            changeDraft(event.target.value)
            if (!event.target.value.startsWith('/')) setDismissed(false)
          }}
          onKeyDown={onKey}
          onPaste={event => {
            if (event.clipboardData.files.length > 0) {
              event.preventDefault()
              attach(Array.from(event.clipboardData.files))

              return
            }

            // The phone's WebView pastes no pictures; the app reads them itself.
            if (canClipboard && event.clipboardData.getData('text') === '') {
              const file = clipboardImageFile()

              if (file !== null) {
                event.preventDefault()
                attach([file])
              }
            }
          }}
        />
        <button type="button" className="btn btn--allow" disabled={!ready || sending || uploading || text === ''} onClick={() => void send()}>
          {t('action.send')}
        </button>
      </div>
    </div>
  )
}


type PaneProps = {
  sessionId: string | null
  entry: PcEntry | null
  live: PcSession | null
  feed: Feed | null
  stream: LiveStream | undefined
  multiPc: boolean
  tone: Tone
  now: number
  focused: boolean
  // Several panes on screen: each gets a head that splits or closes it.
  // `onBrowser` opens the browser beside this pane (Windows).
  tiles: { canSplit: boolean; canClose: boolean; onSplit: (dir: 'row' | 'column') => void; onClose: () => void; onBrowser: (() => void) | null } | null
  onFocus: () => void
  onDeleted: (sessionId: string) => void
  onSend: (sessionId: string, text: string) => Promise<boolean>
  onUpload: UploadFn
  loadCommands: CommandsFn
}

// One conversation: the transcript (paged), what Claude is typing, the
// queue, slash command output, and a prompt box for that session.
function ConversationPane(props: PaneProps) {
  const { sessionId, entry, live, feed, stream, multiPc, tone, now, focused, tiles, onFocus, onDeleted, onSend, onUpload, loadCommands } = props
  const { t } = useI18n()
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [missing, setMissing] = useState(false)
  // Where the shown part of the conversation starts. Once set, refreshes
  // ask from there, so new messages are added and none slide off the top.
  const [from, setFrom] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<'ask' | 'busy' | null>(null)
  const [held, setHeld] = useState<{ text: string; at: number } | null>(null)
  // Prompts on their way in, one bubble each until the transcript has them.
  const [outbox, setOutbox] = useState<OutPrompt[]>([])
  const scroller = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const content = useRef<HTMLDivElement>(null)
  const lastTop = useRef(0)
  // Shown when the person scrolled up and the view stopped following.
  const [away, setAway] = useState(false)
  const layout = useRef({ height: 0, firstId: '' })
  // Pictures of this session (Claude's and the person's uploads), oldest first.
  const [pictures, setPictures] = useState<GalleryImage[]>([])
  const [viewing, setViewing] = useState<GalleryImage | null>(null)
  const galleryAt = feed?.snapshot?.gallery.latestAt ?? 0

  // Read again whenever the PC's gallery gets a picture, so they show up live.
  useEffect(() => {
    if (feed === null || sessionId === null) {
      setPictures([])

      return
    }

    let stopped = false

    void fetchGallery(feed.connection).then(list => {
      if (!stopped) setPictures(list.filter(image => image.sessionId === sessionId).sort((a, b) => a.at - b.at))
    })

    return () => {
      stopped = true
    }
  }, [sessionId, feed?.connection.token, galleryAt])

  useBackLayer(viewing !== null, () => setViewing(null))

  useEffect(() => {
    if (viewing === null) return

    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setViewing(null)
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [viewing])

  useEffect(() => {
    setFrom(null)
    setHeld(null)
    setOutbox([])
    pinnedToBottom.current = true
    setAway(false)
  }, [sessionId])

  // Live sessions refresh whenever they move; a short delay lets the
  // transcript catch up with the hook that announced the change.
  useEffect(() => {
    if (feed === null || sessionId === null) return

    const connection = feed.connection
    const timer = window.setTimeout(() => {
      void fetchConversation(connection, sessionId, PAGE, from).then(next => {
        setMissing(next === null)
        if (next === null) return
        setConversation(next)
        if (from === null) setFrom(next.start)
      })
    }, 400)

    return () => window.clearTimeout(timer)
  }, [feed?.key, feed?.connection.token, sessionId, from, live?.updatedAt, live?.status])

  const shown = conversation?.sessionId === sessionId ? conversation : null
  const working = live !== null && (live.status === 'thinking' || live.status === 'working' || live.status === 'waiting')

  const queuedPrompts = useMemo(() => (live?.queued ?? []).flatMap((item): Queued[] => (item.mode === 'command' ? [] : [{ text: item.text, mode: item.mode }])), [live?.queued])

  useEffect(() => {
    setOutbox(current => syncOutbox(current, queuedPrompts, shown?.messages ?? null, Date.now(), () => crypto.randomUUID()))
  }, [queuedPrompts, shown, now])

  // Shown the moment it is sent; slash commands have their own bubbles.
  const onSent = (text: string, mode: PromptMode | null): void => {
    if (!text.startsWith('/')) setOutbox(current => [...current, outPrompt(crypto.randomUUID(), text, mode, shown?.messages ?? null, Date.now())])
    followBottom()
  }
  // Claude's reply as it is being written.
  const typing =
    working && stream !== undefined && stream.toolUseId === null && now - stream.at < 15_000 ? `${stream.skippedLines > 0 ? '…\n' : ''}${stream.text}` : ''

  // The reply stays on screen after the stream moves on (to a tool, or the
  // turn ends) until the transcript has it, so it never blinks out.
  useEffect(() => {
    if (typing !== '') setHeld({ text: typing, at: Date.now() })
  }, [typing])

  const heldHead = held === null ? '' : held.text.replace(/^…\n/, '').trim().slice(0, 80)
  const settled = held !== null && shown !== null && shown.messages.some(message => message.role === 'assistant' && message.text.trim().startsWith(heldHead))
  const lingering = held !== null && !settled && now - held.at < HOLD_REPLY_MS ? held.text : ''
  // Word by word, like the terminal.
  const typed = useTypewriter(typing !== '' ? typing : lingering)

  // Loading older messages keeps what was on screen where it was.
  useLayoutEffect(() => {
    const element = scroller.current
    const firstId = shown?.messages[0]?.id ?? ''

    if (element === null) return

    if (!pinnedToBottom.current && layout.current.firstId !== '' && firstId !== layout.current.firstId) {
      element.scrollTop += element.scrollHeight - layout.current.height
    }

    layout.current = { height: element.scrollHeight, firstId }
  }, [shown])

  const stickToBottom = (): void => {
    const element = scroller.current

    if (element !== null) element.scrollTop = element.scrollHeight
  }

  const followBottom = (): void => {
    pinnedToBottom.current = true
    setAway(false)
    stickToBottom()
  }

  // Follow new messages unless the person scrolled up to read: whatever makes
  // the conversation taller (a message, a reply being typed, a picture or code
  // block settling) keeps the bottom in view.
  // The view itself shrinking counts too: the phone keyboard opening or the
  // prompt box growing would otherwise hide the newest lines.
  useEffect(() => {
    const element = content.current
    const view = scroller.current

    if (element === null || view === null) return

    const observer = new ResizeObserver(() => {
      if (pinnedToBottom.current) stickToBottom()
    })

    observer.observe(element)
    observer.observe(view)

    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (pinnedToBottom.current) stickToBottom()
  }, [conversation, live?.queued.length, outbox.length, typed, live?.commandLog.length])

  // A past conversation goes to the PC's trash; a live one stays.
  const remove = async (): Promise<void> => {
    if (entry === null || feed === null) return

    setDeleting('busy')

    const result = await deleteConversation(feed.connection, entry.sessionId)

    setDeleting(null)
    showToast(result === 'deleted' ? t('chat.deleted') : result === 'live' ? t('chat.deleteLive') : t('newSession.failed'))

    if (result === 'deleted') {
      setConversation(null)
      onDeleted(entry.sessionId)
    }
  }

  const canDelete = entry !== null && !entry.live && live === null
  // A reload already waits for the session to be idle.
  const reloading = live?.queued.some(item => item.mode === 'command' && item.text === '/reload-plugins') === true
  const status = live?.status ?? 'ended'

  const messageBubble = (message: ChatMessage) =>
    message.role === 'note' ? (
      <div className="chat-note" key={message.id}>
        {t('chat.compacted')}
      </div>
    ) : message.role === 'user' ? (
      <div className="bubble bubble--me" key={message.id}>
        <Markdown text={message.text} />
      </div>
    ) : (
      <div className="bubble-row" key={message.id}>
        <Buddy pose="base" mood="calm" tone={tone} size={28} />
        <div className="bubble bubble--claude">
          <Markdown text={message.text} />
        </div>
      </div>
    )

  // A picture where it happened: the person's uploads on their side,
  // what Claude opened or captured on Claude's.
  const pictureBubble = (image: GalleryImage) => {
    const picture = (
      <button type="button" className="bubble-picture" onClick={() => setViewing(image)} title={image.path ?? image.name}>
        <RemoteImage connection={feed?.connection ?? null} id={image.id} alt={image.name} lazy />
      </button>
    )

    return image.tool === 'upload' ? (
      <div className="bubble bubble--me bubble--picture" key={`picture-${image.id}`}>
        {picture}
      </div>
    ) : (
      <div className="bubble-row" key={`picture-${image.id}`}>
        <Buddy pose="read" mood="calm" tone={tone} size={28} />
        <div className="bubble bubble--claude bubble--picture">
          {picture}
          <span className="bubble-picture-meta">
            {image.tool} · {image.name}
          </span>
        </div>
      </div>
    )
  }

  return (
    <section className={`convo-main ${tiles !== null ? 'pane' : ''} ${focused && tiles !== null ? 'pane--focused' : ''}`} onPointerDown={onFocus}>
      {tiles !== null && (
        <header className="pane-head">
          <span className={`status-dot dot--${entry?.live === true ? status : 'ended'}`} />
          <span className="pane-title">
            <span className="pane-name">{entry === null ? t('chat.paneEmpty') : entry.title === '' ? t('chat.untitled') : entry.title}</span>
            {entry !== null && (
              <span className="pane-meta">
                {entry.project}
                {multiPc && entry.pcName !== '' && ` · ${entry.pcName}`}
              </span>
            )}
          </span>
          {tiles.onBrowser !== null && (
            <button type="button" className="icon-btn" onClick={tiles.onBrowser} aria-label={t('browser.openBeside')} title={t('browser.openBeside')}>
              <GlobeIcon size={15} />
            </button>
          )}
          {tiles.canSplit && (
            <>
              <button type="button" className="icon-btn" onClick={() => tiles.onSplit('row')} aria-label={t('chat.split')} title={t('chat.split')}>
                <SplitIcon size={15} />
              </button>
              <button type="button" className="icon-btn" onClick={() => tiles.onSplit('column')} aria-label={t('chat.splitDown')} title={t('chat.splitDown')}>
                <SplitDownIcon size={15} />
              </button>
            </>
          )}
          {tiles.canClose && (
            <button type="button" className="icon-btn" onClick={tiles.onClose} aria-label={t('chat.closePane')} title={t('chat.closePane')}>
              <XIcon size={15} />
            </button>
          )}
        </header>
      )}

      <div className="convo-scroll-wrap">
      <div
        className="convo-scroll"
        ref={scroller}
        onScroll={event => {
          const element = event.currentTarget

          // Only the person scrolling up stops the follow; content growing (or
          // the browser nudging the position as it does) never does.
          if (element.scrollHeight - element.scrollTop - element.clientHeight < 60) pinnedToBottom.current = true
          else if (element.scrollTop < lastTop.current - 1) pinnedToBottom.current = false
          lastTop.current = element.scrollTop
          setAway(!pinnedToBottom.current)
        }}
      >
        <div className="convo-content" ref={content}>
        {sessionId === null ? (
          <div className="empty">
            <div className="empty-title">{tiles === null ? t('chat.empty') : t('chat.paneEmpty')}</div>
          </div>
        ) : missing ? (
          <div className="empty">
            <div className="empty-sub">{t('chat.noTranscript')}</div>
          </div>
        ) : shown === null ? (
          <div className="empty">
            <div className="empty-sub">{t('chat.loading')}</div>
          </div>
        ) : (
          <>
            {shown.start > 0 && (
              <button
                type="button"
                className="btn small convo-older"
                onClick={() => {
                  pinnedToBottom.current = false
                  setFrom(Math.max(0, shown.start - PAGE))
                }}
              >
                {t('chat.loadOlder')}
              </button>
            )}
            {withPictures(shown.messages, pictures, shown.start === 0).map(item =>
              'image' in item ? (
                pictureBubble(item.image)
              ) : (
                messageBubble(item.message)
              ),
            )}
            {outbox.flatMap(item =>
              arrived(item, queuedPrompts, shown.messages)
                ? []
                : [
                    <div className={`bubble bubble--me bubble--out ${item.leftAt === null ? 'bubble--queued' : ''}`} key={item.key}>
                      {item.leftAt === null && working && item.mode !== null && <span className="queued-tag">{t(QUEUED_LABEL[item.mode])}</span>}
                      <Markdown text={item.text} />
                    </div>,
                  ],
            )}
            {live?.commandLog.map(result => (
              <div className="bubble-row" key={result.id}>
                <span className="command-mark">/</span>
                <div className={`bubble bubble--command ${result.failed ? 'bubble--failed' : ''}`}>
                  <div className="command-title">
                    /{result.command}
                    {result.args === '' ? '' : ` ${result.args}`}
                  </div>
                  {result.text !== '' && <pre className="command-output">{result.text}</pre>}
                </div>
              </div>
            ))}
            {live?.queued.flatMap((item, index) =>
              item.mode === 'command'
                ? [
                    <div className="bubble bubble--me bubble--out bubble--queued" key={`c-${index}-${item.text}`}>
                      <span className="queued-tag">{t(QUEUED_LABEL[item.mode])}</span>
                      <Markdown text={item.text} />
                    </div>,
                  ]
                : [],
            )}
            {(working || typed !== '') && (
              <div className="bubble-row bubble-row--in">
                <Buddy pose="think" mood="busy" tone={tone} size={28} />
                <div className="bubble bubble--claude">
                  {typed === '' ? <span className="typing">{t('chat.working')}</span> : <Markdown text={working ? `${typed}▍` : typed} />}
                </div>
              </div>
            )}
          </>
        )}
        </div>
      </div>
      {away && (
        <button
          type="button"
          className="convo-jump"
          onClick={followBottom}
          aria-label={t('chat.jumpDown')}
          title={t('chat.jumpDown')}
        >
          <ChevronDownIcon size={18} />
        </button>
      )}
      </div>

      <div className="convo-foot">
        {live?.modOutdated === true && feed !== null && (
          <div className="mod-notice">
            <span className="mod-notice-text">{reloading ? t('mod.reloading') : t('mod.outdated')}</span>
            {!reloading && (
              <button
                type="button"
                className="btn small"
                onClick={() => void reloadPlugins(feed.connection, live.id).then(ok => showToast(ok ? t('mod.reloadQueued') : t('chat.actionFailed')))}
              >
                {t('menu.reload')}
              </button>
            )}
          </div>
        )}
        {entry !== null && (
          <div className="convo-path-row">
            <span className="convo-path">
              {entry.cwd}
              {live !== null && ` · ${t('chat.tools', { n: live.toolCount })}`}
            </span>
            {canDelete && (
              <button type="button" className="btn small convo-delete" onClick={() => setDeleting('ask')}>
                <TrashIcon size={13} /> {t('chat.delete')}
              </button>
            )}
          </div>
        )}
        <Composer session={live} onSend={onSend} onUpload={onUpload} loadCommands={loadCommands} compact={tiles !== null} onSent={onSent} />
      </div>

      {viewing !== null && (
        <div className="viewer" role="dialog" aria-modal="true" aria-label={viewing.name}>
          <div className="viewer-head">
            <span className="viewer-title">
              <span className="viewer-name">{viewing.name}</span>
              <span className="viewer-meta">{viewing.tool}</span>
            </span>
            {feed !== null && (
              <button type="button" className="icon-btn" onClick={() => void saveImage(feed.connection, viewing.id, viewing.name)} title={t('gallery.save')}>
                <DownloadIcon size={18} />
              </button>
            )}
            <button type="button" className="icon-btn" onClick={() => setViewing(null)} title={t('action.close')}>
              <XIcon size={18} />
            </button>
          </div>
          <div className="viewer-body">
            <RemoteImage key={viewing.id} connection={feed?.connection ?? null} id={viewing.id} alt={viewing.name} retry />
          </div>
        </div>
      )}

      {deleting !== null && entry !== null && (
        <ConfirmSheet
          title={t('chat.deleteTitle')}
          hint={`${entry.title === '' ? entry.project : entry.title}\n\n${t('chat.deleteHint')}`}
          confirmLabel={t('action.delete')}
          busy={deleting === 'busy'}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  )
}

// Panes need room: below this width only the pane in focus is drawn.
const SPLIT_MIN_PX = 900

type ChatProps = {
  streams: ReadonlyMap<string, LiveStream>
  feeds: Feed[]
  multiPc: boolean
  sessions: PcSession[]
  selectedId: string | null
  onSelect: (sessionId: string, live: boolean) => void
  tone: Tone
  now: number
  onSend: (sessionId: string, text: string) => Promise<boolean>
  onUpload: UploadFn
  loadCommands: CommandsFn
  onNewSession: () => void
}

// Every conversation, PC by PC: the PCs as buddies on the left, the chosen
// PC's sessions next to them, and the conversations in panes that split
// left/right or top/bottom like tmux (on a wide screen), each with its own
// prompt box.
export function Chat({ streams, feeds, multiPc, sessions, selectedId, onSelect, tone, now, onSend, onUpload, loadCommands, onNewSession }: ChatProps) {
  const { t } = useI18n()
  const [tile, setTile] = useTiles('chatTiles')
  const [focusId, setFocusId] = useState('')
  const wide = useWide(SPLIT_MIN_PX)
  const leaves = leavesOf(tile)
  // The panes with conversations; the browser pane never takes the focus.
  const panes = sessionLeavesOf(tile)
  const focused = panes.find(leaf => leaf.id === focusId) ?? panes[0]
  const focusedId = focused?.sessionId ?? null
  const shownIds = new Set(panes.flatMap(leaf => (leaf.sessionId === null ? [] : [leaf.sessionId])))
  const hasBrowser = leaves.length > panes.length

  const pick = (entry: PcEntry): void => onSelect(entry.sessionId, entry.live)

  const nav = useSessionNav({
    feeds,
    sessions,
    tone,
    now,
    focusedId,
    shownIds,
    onPick: pick,
    onNewSession,
    onDeleted: sessionId => setTile(current => forgetSession(current, sessionId)),
  })

  // The list (and the app) picks what the pane in focus shows; a session
  // already open in another pane moves the focus there instead.
  useEffect(() => {
    if (selectedId === null || focusedId === selectedId) return

    const at = panes.find(leaf => leaf.sessionId === selectedId)

    if (at !== undefined) {
      setFocusId(at.id)

      return
    }

    if (focused !== undefined) setTile(current => setLeafSession(current, focused.id, selectedId))
  }, [selectedId, focused?.id])

  const focusLeaf = (leaf: TileLeaf): void => {
    setFocusId(leaf.id)

    const entry = nav.entryOf(leaf.sessionId)

    if (entry !== null && entry.sessionId !== selectedId) pick(entry)
  }

  // The new pane shows a session not on screen yet.
  const split = (leafId: string, dir: 'row' | 'column'): void => {
    if (leaves.length >= MAX_TILES) return

    const next = nav.entries.find(entry => !shownIds.has(entry.sessionId)) ?? null
    const result = splitLeaf(tile, leafId, dir, next?.sessionId ?? null)

    setTile(() => result.tree)
    setFocusId(result.id)
    if (next !== null) pick(next)
  }

  const close = (leafId: string): void => {
    const rest = closeLeaf(tile, leafId)
    const restPanes = sessionLeavesOf(rest)
    const first = restPanes.find(leaf => leaf.id === focused?.id) ?? restPanes[0]

    setTile(() => rest)
    if (first !== undefined) focusLeaf(first)
  }

  const canBrowser = platform === 'windows' && (hasBrowser || leaves.length < MAX_TILES)

  return (
    <div className="convo convo--chat">
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
              // A browser pane without its own session works for the pane in focus.
              const sessionId = leaf.view === 'browser' ? (leaf.sessionId ?? focusedId) : leaf.sessionId
              const entry = nav.entryOf(sessionId)
              const live = sessions.find(session => session.id === sessionId) ?? null
              const feed = feedFor(feeds, live?.pcKey ?? entry?.pcKey)

              if (leaf.view === 'browser') {
                return (
                  <BrowserPane
                    key={leaf.id}
                    session={live}
                    title={entry === null ? t('chat.paneEmpty') : entry.title === '' ? t('chat.untitled') : entry.title}
                    onClose={() => close(leaf.id)}
                    onSend={onSend}
                    onUpload={onUpload}
                    loadCommands={loadCommands}
                  />
                )
              }

              return (
                <ConversationPane
                  key={leaf.id}
                  sessionId={leaf.sessionId}
                  entry={entry}
                  live={live}
                  feed={feed}
                  stream={leaf.sessionId === null ? undefined : streams.get(leaf.sessionId)}
                  multiPc={multiPc}
                  tone={tone}
                  now={now}
                  focused={leaf.id === focused?.id}
                  tiles={
                    wide
                      ? {
                          canSplit: leaves.length < MAX_TILES,
                          canClose: panes.length > 1,
                          onSplit: dir => split(leaf.id, dir),
                          onClose: () => close(leaf.id),
                          onBrowser: canBrowser ? () => setTile(current => openBrowserBeside(current, leaf.id, leaf.sessionId)) : null,
                        }
                      : null
                  }
                  onFocus={() => {
                    if (leaf.id !== focused?.id) focusLeaf(leaf)
                  }}
                  onDeleted={sessionId => setTile(current => forgetSession(current, sessionId))}
                  onSend={onSend}
                  onUpload={onUpload}
                  loadCommands={loadCommands}
                />
              )
            }}
          />
        </div>
      </div>

      {nav.overlays}
    </div>
  )
}
