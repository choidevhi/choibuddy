import { Fragment, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type CommandInfo, type Conversation, type HistoryEntry, type LiveStream, PROMPT_MODES, type PromptMode, type QueuedItem, type Session } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { Buddy, type Mood, type Pose, tintFor, type Tone } from './buddy.tsx'
import { ConfirmSheet, showToast } from './confirm.tsx'
import { ago, type MessageKey, useI18n } from './i18n.ts'
import { type Feed, feedFor, type PcSession } from './feeds.ts'
import { ChevronDownIcon, ClipboardIcon, PaperclipIcon, PlusIcon, SpinnerIcon, SplitIcon, TrashIcon, XIcon } from './icons.tsx'
import { clipboardImageFile } from './images.tsx'
import { archiveSessions, deleteConversation, endSession, fetchConversation, fetchHistory, renameSession, type Uploaded } from './live.ts'
import { Markdown } from './markdown.tsx'
import { ContextMenu, type MenuEntry } from './menu.tsx'
import { Picker } from './picker.tsx'
import { platform, readPref } from './platform.ts'
import { useTypewriter } from './typewriter.ts'

const PAGE = 150
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
  // Called once a prompt went out, so the conversation can jump to the bottom.
  onSent?: () => void
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

      setFiles(current => [...current, { key, name: file.name === '' ? 'pasted.png' : file.name, path: null, failed: false }])
      void onUpload(session.id, file).then(result =>
        setFiles(current => current.map(item => (item.key === key ? { ...item, path: result?.path ?? null, failed: result === null } : item))),
      )
    }
  }

  // What the browser hands over lands in the box, ready to add words to.
  useEffect(() => {
    if (inject === null) return

    setDraft(current => (current.trim() === '' ? inject.text : `${current.trimEnd()}\n\n${inject.text}`))
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

    const ok = await onSend(session.id, text, busy ? mode : undefined)

    setSending(false)

    if (ok) {
      setDraft('')
      setFiles([])
      setDismissed(false)
      setMode(readPref('promptMode', PROMPT_MODES, 'steer'))
      onSent?.()
    }
  }

  const complete = (command: CommandInfo): void => {
    setDraft(`/${command.name} `)
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
              <button type="button" className="chip-remove" onClick={() => setFiles(current => current.filter(item => item.key !== file.key))} aria-label="×">
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
            setDraft(event.target.value)
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

// A session from any PC, with the PC it lives on.
type PcEntry = HistoryEntry & { pcKey: string; pcName: string }

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
  // Several panes side by side: each gets a head with its own controls.
  split: { canAdd: boolean; canClose: boolean; onAdd: () => void; onClose: () => void } | null
  onFocus: () => void
  onDeleted: (sessionId: string) => void
  onSend: (sessionId: string, text: string) => Promise<boolean>
  onUpload: UploadFn
  loadCommands: CommandsFn
}

// One conversation: the transcript (paged), what Claude is typing, the
// queue, slash command output, and a prompt box for that session.
function ConversationPane(props: PaneProps) {
  const { sessionId, entry, live, feed, stream, multiPc, tone, now, focused, split, onFocus, onDeleted, onSend, onUpload, loadCommands } = props
  const { t } = useI18n()
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [missing, setMissing] = useState(false)
  // Where the shown part of the conversation starts. Once set, refreshes
  // ask from there, so new messages are added and none slide off the top.
  const [from, setFrom] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<'ask' | 'busy' | null>(null)
  const [held, setHeld] = useState<{ text: string; at: number } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const content = useRef<HTMLDivElement>(null)
  const lastTop = useRef(0)
  // Shown when the person scrolled up and the view stopped following.
  const [away, setAway] = useState(false)
  const layout = useRef({ height: 0, firstId: '' })

  useEffect(() => {
    setFrom(null)
    setHeld(null)
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
  }, [conversation, live?.queued.length, typed, live?.commandLog.length])

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
  const status = live?.status ?? 'ended'

  return (
    <section className={`convo-main ${split !== null ? 'pane' : ''} ${focused && split !== null ? 'pane--focused' : ''}`} onPointerDown={onFocus}>
      {split !== null && (
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
          {split.canAdd && (
            <button type="button" className="icon-btn" onClick={split.onAdd} aria-label={t('chat.split')} title={t('chat.split')}>
              <SplitIcon size={15} />
            </button>
          )}
          {split.canClose && (
            <button type="button" className="icon-btn" onClick={split.onClose} aria-label={t('chat.closePane')} title={t('chat.closePane')}>
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
            <div className="empty-title">{split === null ? t('chat.empty') : t('chat.paneEmpty')}</div>
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
            {shown.messages.map(message =>
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
              ),
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
            {live?.queued.map((item, index) => (
              <div className="bubble bubble--me bubble--queued" key={`q-${index}-${item.text}`}>
                <span className="queued-tag">{t(QUEUED_LABEL[item.mode])}</span>
                <Markdown text={item.text} />
              </div>
            ))}
            {(working || typed !== '') && (
              <div className="bubble-row">
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
        <Composer session={live} onSend={onSend} onUpload={onUpload} loadCommands={loadCommands} compact={split !== null} onSent={followBottom} />
      </div>

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

const MAX_PANES = 4
const MIN_SHARE = 0.18
const SPLIT_KEY = 'choibuddy.chatSplit'
// Below this width one conversation is shown at a time.
const SPLIT_MIN_PX = 900

type Split = {
  panes: Array<string | null>
  sizes: number[]
}

function readSplit(): Split {
  try {
    const parsed: Partial<Split> | null = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null')
    const panes = Array.isArray(parsed?.panes) ? parsed.panes.slice(0, MAX_PANES).map(id => (typeof id === 'string' ? id : null)) : []
    const sizes = Array.isArray(parsed?.sizes) && parsed.sizes.length === panes.length ? parsed.sizes.map(size => (typeof size === 'number' && size > 0 ? size : 1)) : panes.map(() => 1)

    return panes.length === 0 ? { panes: [null], sizes: [1] } : { panes, sizes }
  } catch {
    return { panes: [null], sizes: [1] }
  }
}

function saveSplit(split: Split): void {
  try {
    localStorage.setItem(SPLIT_KEY, JSON.stringify(split))
  } catch {
    // Remembering the layout is a convenience.
  }
}

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= SPLIT_MIN_PX)

  useEffect(() => {
    const onResize = (): void => setWide(window.innerWidth >= SPLIT_MIN_PX)

    window.addEventListener('resize', onResize)

    return () => window.removeEventListener('resize', onResize)
  }, [])

  return wide
}

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

// What the right click (or long press) opened, and where.
type MenuState = { entry: PcEntry; at: { x: number; y: number } }

// A question before ending a session or deleting conversations.
type Asking = { kind: 'end'; entry: PcEntry } | { kind: 'delete'; entries: PcEntry[] }

type Groups = { live: PcEntry[]; ended: PcEntry[]; archived: PcEntry[] }

function groupsOf(entries: PcEntry[], pcKey: string | null): Groups {
  const groups: Groups = { live: [], ended: [], archived: [] }

  for (const entry of entries) {
    if (entry.pcKey !== pcKey) continue
    if (entry.live) groups.live.push(entry)
    else if (entry.archived) groups.archived.push(entry)
    else groups.ended.push(entry)
  }

  return groups
}

function pcName(feed: Feed): string {
  return feed.snapshot?.server.hostName ?? feed.connection.baseUrl.replace(/^https?:\/\//, '')
}

// A PC's buddy shows how that PC is doing: asking, working, resting or gone.
function pcLook(feed: Feed, sessions: PcSession[]): { pose: Pose; mood: Mood; status: string } {
  const mine = sessions.filter(session => session.pcKey === feed.key)

  if (feed.link !== 'live') return { pose: 'closed', mood: 'sleep', status: 'ended' }
  if (mine.some(session => session.status === 'waiting')) return { pose: 'warning', mood: 'alert', status: 'waiting' }
  if (mine.some(session => session.status === 'working' || session.status === 'thinking')) return { pose: 'think', mood: 'busy', status: 'working' }

  return { pose: 'base', mood: 'calm', status: mine.length > 0 ? 'idle' : 'ended' }
}

// The connected PCs as buddies of their own colour. A PC's name shows on hover.
function PcRail({ feeds, sessions, shown, tone, onPick }: { feeds: Feed[]; sessions: PcSession[]; shown: string | null; tone: Tone; onPick: (key: string) => void }) {
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

// Every conversation, PC by PC: the PCs as buddies on the left, the chosen
// PC's sessions next to them (open ones, then ended ones, then the archive),
// and on a wide screen up to four conversations side by side, each resizable
// and with its own prompt box. A right click (long press on a phone) on a
// session renames, ends, archives or deletes it.
export function Chat({ streams, feeds, multiPc, sessions, selectedId, onSelect, tone, now, onSend, onUpload, loadCommands, onNewSession }: ChatProps) {
  const { t } = useI18n()
  const [history, setHistory] = useState<PcEntry[]>([])
  const [reloadAt, setReloadAt] = useState(0)
  const [split, setSplit] = useState<Split>(readSplit)
  const [focus, setFocus] = useState(0)
  const [pcKey, setPcKey] = useState<string | null>(null)
  const [showArchive, setShowArchive] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<PcEntry | null>(null)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [busy, setBusy] = useState(false)
  const wide = useWide()
  const row = useRef<HTMLDivElement>(null)
  const liveIds = sessions.map(session => session.id).join(',')
  const feedIds = feeds.map(feed => `${feed.key}#${feed.connection.token}`).join('|')

  // Every PC's sessions: live ones first, then the newest.
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

  useEffect(() => saveSplit(split), [split])

  const focusIndex = Math.min(focus, split.panes.length - 1)
  // On a narrow screen only the pane in focus is drawn.
  const visible = wide ? split.panes.map((sessionId, index) => ({ sessionId, index })) : [{ sessionId: split.panes[focusIndex] ?? null, index: focusIndex }]
  const focusedId = split.panes[focusIndex] ?? null

  // The list (and the app) picks what the pane in focus shows; a session
  // already open in another pane moves the focus there instead.
  useEffect(() => {
    if (selectedId === null || focusedId === selectedId) return

    const at = split.panes.indexOf(selectedId)

    if (at !== -1) {
      setFocus(at)

      return
    }

    setSplit(current => ({ ...current, panes: current.panes.map((id, index) => (index === focusIndex ? selectedId : id)) }))
  }, [selectedId, focusIndex])

  const entries: PcEntry[] =
    history.length > 0
      ? history
      : sessions.map(session => ({
          sessionId: session.id,
          project: session.name,
          cwd: session.cwd,
          title: '',
          updatedAt: session.updatedAt,
          live: true,
          archived: false,
          pcKey: session.pcKey,
          pcName: session.pcName,
        }))

  const entryOf = (sessionId: string | null): PcEntry | null => (sessionId === null ? null : (entries.find(entry => entry.sessionId === sessionId) ?? null))
  const focusedPc = entryOf(focusedId)?.pcKey ?? null

  // The list follows the PC of the conversation in focus (picked here or on the home screen).
  useEffect(() => {
    if (focusedPc !== null) setPcKey(focusedPc)
  }, [focusedPc])

  const shownPc = pcKey !== null && feeds.some(feed => feed.key === pcKey) ? pcKey : (focusedPc ?? feeds[0]?.key ?? null)
  const shownFeed = feeds.find(feed => feed.key === shownPc) ?? null
  const groups = groupsOf(entries, shownPc)
  const statusOf = (entry: PcEntry): string => (entry.live ? (sessions.find(session => session.id === entry.sessionId)?.status ?? 'ended') : 'ended')

  const pick = (entry: PcEntry): void => onSelect(entry.sessionId, entry.live)

  const focusPane = (index: number): void => {
    setFocus(index)

    const entry = entryOf(split.panes[index] ?? null)

    if (entry !== null && entry.sessionId !== selectedId) pick(entry)
  }

  const addPane = (): void => {
    const shownIds = new Set(split.panes)
    const next = entries.find(entry => !shownIds.has(entry.sessionId)) ?? null

    setSplit(current => ({ panes: [...current.panes, next?.sessionId ?? null], sizes: current.panes.map(() => 1).concat(1) }))
    setFocus(split.panes.length)
    if (next !== null) pick(next)
  }

  const closePane = (index: number): void => {
    const panesLeft = split.panes.filter((_, at) => at !== index)
    const sizesLeft = split.sizes.filter((_, at) => at !== index)
    const nextFocus = Math.min(index === focusIndex ? Math.max(0, index - 1) : focusIndex > index ? focusIndex - 1 : focusIndex, panesLeft.length - 1)

    setSplit({ panes: panesLeft, sizes: sizesLeft })
    setFocus(nextFocus)

    const entry = entryOf(panesLeft[nextFocus] ?? null)

    if (entry !== null) pick(entry)
  }

  const onDeleted = (sessionId: string): void => {
    setHistory(list => list.filter(entry => entry.sessionId !== sessionId))
    setSplit(current => ({ ...current, panes: current.panes.map(id => (id === sessionId ? null : id)) }))
  }

  const connectionOf = (entry: PcEntry) => feedFor(feeds, entry.pcKey)?.connection ?? null

  const archive = async (list: PcEntry[], archived: boolean): Promise<void> => {
    const connection = list[0] === undefined ? null : connectionOf(list[0])

    if (connection === null) return

    const ids = new Set(list.map(entry => entry.sessionId))
    const ok = await archiveSessions(connection, [...ids], archived)

    if (!ok) {
      showToast(t('chat.actionFailed'))

      return
    }

    setHistory(current => current.map(entry => (ids.has(entry.sessionId) ? { ...entry, archived } : entry)))
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
    if (title.trim() === '') setReloadAt(Date.now())
    else setHistory(current => current.map(item => (item.sessionId === entry.sessionId ? { ...item, title: title.replace(/\s+/g, ' ').trim() } : item)))
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

      if (result === 'deleted') onDeleted(entry.sessionId)
      else failed += 1
    }

    if (failed > 0) showToast(t('chat.actionFailed'))
  }

  const menuItems = (entry: PcEntry): Array<MenuEntry | null> => {
    const renameItem: MenuEntry = { label: t('menu.rename'), onSelect: () => setRenaming(entry) }

    if (entry.live) {
      const canEnd = sessions.find(session => session.id === entry.sessionId)?.canPrompt === true

      return [renameItem, null, { label: t('menu.end'), danger: true, disabled: !canEnd, hint: canEnd ? undefined : t('menu.endNoMod'), onSelect: () => setAsking({ kind: 'end', entry }) }]
    }

    const ended = groupsOf(entries, entry.pcKey).ended

    return [
      renameItem,
      { label: entry.archived ? t('menu.unarchive') : t('menu.archive'), onSelect: () => void archive([entry], !entry.archived) },
      { label: t('menu.delete'), danger: true, onSelect: () => setAsking({ kind: 'delete', entries: [entry] }) },
      null,
      { label: t('chat.archiveEnded', { n: ended.length }), disabled: ended.length === 0, onSelect: () => void archive(ended, true) },
      { label: t('chat.deleteEnded', { n: ended.length }), danger: true, disabled: ended.length === 0, onSelect: () => setAsking({ kind: 'delete', entries: ended }) },
    ]
  }

  const openMenu = (entry: PcEntry, at: { x: number; y: number }): void => setMenu({ entry, at })

  // Dragging the line between two panes moves their shares of the width.
  const resize = (index: number, start: { clientX: number }): void => {
    const element = row.current

    if (element === null) return

    const width = element.getBoundingClientRect().width
    const total = split.sizes.reduce((sum, size) => sum + size, 0)
    const startX = start.clientX
    const first = split.sizes[index] ?? 1
    const second = split.sizes[index + 1] ?? 1

    const move = (event: PointerEvent): void => {
      const delta = ((event.clientX - startX) / width) * total
      const floor = MIN_SHARE * total
      const a = Math.min(first + second - floor, Math.max(floor, first + delta))

      setSplit(current => ({ ...current, sizes: current.sizes.map((size, at) => (at === index ? a : at === index + 1 ? first + second - a : size)) }))
    }

    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
    }

    document.body.classList.add('resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const shownIds = new Set(split.panes)
  const titleOf = (entry: PcEntry): string => (entry.title === '' ? t('chat.untitled') : entry.title)
  const metaOf = (entry: PcEntry): string => `${entry.project} · ${entry.live ? t('chat.live') : ago(t, now - entry.updatedAt)}`

  const sessionRow = (entry: PcEntry) => (
    <button
      type="button"
      key={entry.sessionId}
      className={`convo-item ${entry.sessionId === focusedId ? 'on' : shownIds.has(entry.sessionId) ? 'shown' : ''} ${entry.live ? '' : 'convo-item--ended'}`}
      onClick={() => pick(entry)}
      onContextMenu={event => {
        event.preventDefault()
        openMenu(entry, { x: event.clientX, y: event.clientY })
      }}
    >
      <span className={`status-dot convo-dot dot--${statusOf(entry)}`} />
      <span className="convo-item-text">
        <span className="convo-title">{titleOf(entry)}</span>
        <span className="convo-meta">{metaOf(entry)}</span>
      </span>
    </button>
  )

  const pickerOption = (entry: PcEntry, group: string) => ({ value: entry.sessionId, label: titleOf(entry), hint: metaOf(entry), dot: `dot--${statusOf(entry)}`, group })

  return (
    <div className="convo convo--chat">
      <PcRail feeds={feeds} sessions={sessions} shown={shownPc} tone={tone} onPick={setPcKey} />

      <aside className="convo-list">
        <div className="section-label convo-list-head">
          <span className="convo-list-pc">{shownFeed === null ? t('chat.sessions') : pcName(shownFeed)}</span>
          <button type="button" className="btn small" onClick={onNewSession} title={t('newSession.title')}>
            <PlusIcon size={13} /> {t('chat.newSession')}
          </button>
        </div>
        {groups.live.map(sessionRow)}
        {groups.live.length === 0 && <div className="convo-none">{t('chat.noOpen')}</div>}
        {groups.ended.length > 0 && (
          <div className="convo-divider">
            <span className="convo-divider-label">
              {t('chat.groupEnded')} · {groups.ended.length}
            </span>
            <button type="button" className="link-btn" onClick={() => void archive(groups.ended, true)}>
              {t('chat.archiveAll')}
            </button>
            <button type="button" className="link-btn link-btn--danger" onClick={() => setAsking({ kind: 'delete', entries: groups.ended })}>
              {t('chat.deleteAll')}
            </button>
          </div>
        )}
        {groups.ended.map(sessionRow)}
        {groups.archived.length > 0 && (
          <button type="button" className="convo-divider convo-archive-toggle" onClick={() => setShowArchive(!showArchive)} aria-expanded={showArchive}>
            <span className="convo-divider-label">
              {t('chat.groupArchived')} · {groups.archived.length}
            </span>
            <span className="picker-caret">{showArchive ? '▾' : '▸'}</span>
          </button>
        )}
        {showArchive && groups.archived.map(sessionRow)}
      </aside>

      <div className="convo-panes">
        <div className="convo-select-row">
          {feeds.length > 1 && (
            <div className="pc-chips" role="tablist" aria-label={t('chat.pcs')}>
              {feeds.map(feed => {
                const look = pcLook(feed, sessions)

                return (
                  <button
                    type="button"
                    role="tab"
                    key={feed.key}
                    aria-selected={feed.key === shownPc}
                    aria-label={pcName(feed)}
                    title={pcName(feed)}
                    className={`pc-chip ${feed.key === shownPc ? 'on' : ''}`}
                    onClick={() => setPcKey(feed.key)}
                  >
                    <Buddy pose={look.pose} mood={look.mood} tone={tone} tint={tintFor(feed.key)} size={24} />
                  </button>
                )
              })}
            </div>
          )}
          <Picker
            className="convo-select"
            value={focusedId}
            title={shownFeed === null ? t('chat.sessions') : pcName(shownFeed)}
            placeholder={t('chat.empty')}
            options={[
              ...groups.live.map(entry => pickerOption(entry, t('chat.groupLive'))),
              ...groups.ended.map(entry => pickerOption(entry, t('chat.groupEnded'))),
              ...groups.archived.map(entry => pickerOption(entry, t('chat.groupArchived'))),
            ]}
            onChange={sessionId => {
              const entry = entries.find(item => item.sessionId === sessionId)

              if (entry !== undefined) pick(entry)
            }}
            onOptionMenu={(sessionId, at) => {
              const entry = entries.find(item => item.sessionId === sessionId)

              if (entry !== undefined) openMenu(entry, at)
            }}
          />
          <button type="button" className="icon-btn convo-new" onClick={onNewSession} title={t('newSession.title')}>
            <PlusIcon size={17} />
          </button>
        </div>

        <div className="pane-row" ref={row}>
          {visible.map(({ sessionId, index }) => {
            const entry = entryOf(sessionId)
            const live = sessions.find(session => session.id === sessionId) ?? null
            const feed = feedFor(feeds, live?.pcKey ?? entry?.pcKey)

            return (
              <Fragment key={`${index}-${split.panes.length}`}>
                {wide && index > 0 && <div className="pane-divider" role="separator" aria-orientation="vertical" onPointerDown={event => resize(index - 1, event)} />}
                <div className="pane-slot" style={{ flexGrow: wide ? (split.sizes[index] ?? 1) : 1 }}>
                  <ConversationPane
                    sessionId={sessionId}
                    entry={entry}
                    live={live}
                    feed={feed}
                    stream={sessionId === null ? undefined : streams.get(sessionId)}
                    multiPc={multiPc}
                    tone={tone}
                    now={now}
                    focused={index === focusIndex}
                    split={
                      wide
                        ? {
                            canAdd: split.panes.length < MAX_PANES,
                            canClose: split.panes.length > 1,
                            onAdd: addPane,
                            onClose: () => closePane(index),
                          }
                        : null
                    }
                    onFocus={() => {
                      if (index !== focusIndex) focusPane(index)
                    }}
                    onDeleted={onDeleted}
                    onSend={onSend}
                    onUpload={onUpload}
                    loadCommands={loadCommands}
                  />
                </div>
              </Fragment>
            )
          })}
        </div>
      </div>

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
    </div>
  )
}
