import { memo, useContext, useEffect, useRef } from 'react'
import type { CodePreview, ImagePreview, LiveStream, Preview, TerminalPreview, TextPreview, TodoPreview } from '../../shared/protocol.ts'
import { KEY_PREFIX } from '../../shared/protocol.ts'
import { highlightLine, languageBadge } from './highlight.ts'
import { type MessageKey, type Translate, useI18n } from './i18n.ts'
import { CheckCircleIcon, KindIcon, SpinnerIcon } from './icons.tsx'
import { RemoteImage } from './images.tsx'
import { ConnectionContext } from './live.ts'
import { Markdown } from './markdown.tsx'
import { useTypewriter } from './typewriter.ts'

const BRIDGE_KEYS: Record<string, MessageKey> = {
  '@question': 'preview.question',
  '@plan': 'preview.plan',
  '@agent': 'preview.agent',
  '@failed': 'preview.failed',
  '@unpreviewable': 'preview.unpreviewable',
}

// The bridge sends '@key' instead of words for the few labels it makes up.
export function bridgeText(t: Translate, text: string): string {
  if (!text.startsWith(KEY_PREFIX)) return text

  const key = BRIDGE_KEYS[text]

  return key === undefined ? text : t(key)
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(part => part !== '').at(-1) ?? path
}

function relativePath(path: string, cwd: string): string {
  const norm = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/, '')
  const file = norm(path)
  const root = norm(cwd)

  return root !== '' && file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : file
}

function CodeView({ preview, cwd, compact }: { preview: CodePreview; cwd: string; compact: boolean }) {
  const body = useRef<HTMLDivElement>(null)
  const firstMark = preview.lines.findIndex(line => line.mark !== 'none')

  // Bring the change into view; a read starts at the top.
  useEffect(() => {
    const row = firstMark === -1 ? null : body.current?.querySelectorAll<HTMLElement>('.ln')[firstMark]

    if (body.current === null) return
    body.current.scrollTop = row === null || row === undefined ? 0 : Math.max(0, row.offsetTop - body.current.clientHeight / 3)
  }, [preview, firstMark])

  return (
    <div className={`panel code ${compact ? 'compact' : ''}`}>
      <div className="panel-head">
        <span className="file-tab">
          <span className="lang-badge">{languageBadge(preview.language)}</span>
          <span className="file-name">{baseName(preview.path)}</span>
        </span>
        <span className="file-path">{relativePath(preview.path, cwd)}</span>
      </div>
      <div className="panel-body" ref={body}>
        {preview.lines.map((line, index) => (
          <div className={`ln ln--${line.mark}`} key={`${index}-${line.n ?? 'x'}`}>
            <span className="ln-n">{line.n ?? ''}</span>
            <span className="ln-sign">{line.mark === 'add' ? '+' : line.mark === 'del' ? '−' : ''}</span>
            <span className="ln-code">
              {highlightLine(line.text, preview.language).map((token, tokenIndex) => (
                <span className={`tk-${token.kind}`} key={tokenIndex}>
                  {token.text}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TerminalView({ preview, running, compact }: { preview: TerminalPreview; running: boolean; compact: boolean }) {
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (body.current !== null) body.current.scrollTop = body.current.scrollHeight
  }, [preview])

  return (
    <div className={`panel terminal ${compact ? 'compact' : ''}`}>
      <div className="panel-head">
        <span className="file-tab">
          <span className="lang-badge">$_</span>
          <span className="file-name">Terminal</span>
        </span>
        {running && <SpinnerIcon size={14} className="dim" />}
      </div>
      <div className="panel-body" ref={body}>
        <div className="term-cmd">
          <span className="term-prompt">$</span> {preview.command}
        </div>
        {preview.output !== '' && <pre className={`term-out ${preview.failed ? 'failed' : ''}`}>{preview.output}</pre>}
      </div>
    </div>
  )
}

function TextView({ preview, compact }: { preview: TextPreview; compact: boolean }) {
  const { t } = useI18n()

  return (
    <div className={`panel text ${compact ? 'compact' : ''}`}>
      <div className="panel-head">
        <span className="file-tab plain">
          <span className="file-name">{bridgeText(t, preview.title)}</span>
        </span>
      </div>
      <div className="panel-body">
        <pre className="text-body">{bridgeText(t, preview.text)}</pre>
      </div>
    </div>
  )
}

export function TodoList({ preview }: { preview: TodoPreview }) {
  return (
    <div className="todos">
      {preview.items.map((item, index) => (
        <div className={`todo todo--${item.status}`} key={index}>
          {item.status === 'completed' ? <CheckCircleIcon size={15} /> : item.status === 'in_progress' ? <SpinnerIcon size={15} /> : <span className="todo-ring" />}
          <span>{item.content}</span>
        </div>
      ))}
    </div>
  )
}

function TodoView({ preview, compact }: { preview: TodoPreview; compact: boolean }) {
  const { t } = useI18n()

  return (
    <div className={`panel text ${compact ? 'compact' : ''}`}>
      <div className="panel-head">
        <span className="file-tab plain">
          <KindIcon kind="todo" size={14} />
          <span className="file-name">{t('preview.todos')}</span>
        </span>
        <span className="file-path">
          {preview.items.filter(item => item.status === 'completed').length}/{preview.items.length}
        </span>
      </div>
      <div className="panel-body">
        <TodoList preview={preview} />
      </div>
    </div>
  )
}

type LiveRowProps = {
  number: number
  line: string
  language: string
  caret: boolean
}

// Rows are memoised: while words arrive only the last row draws again.
const LiveRow = memo(function LiveRow({ number, line, language, caret }: LiveRowProps) {
  return (
    <div className="ln ln--add">
      <span className="ln-n">{number}</span>
      <span className="ln-sign">+</span>
      <span className="ln-code">
        {highlightLine(line, language).map((token, index) => (
          <span className={`tk-${token.kind}`} key={index}>
            {token.text}
          </span>
        ))}
        {caret && <span className="caret" />}
      </span>
    </div>
  )
})

// Code Claude is typing right now, word by word, with a caret at the end.
export function LiveCodeView({ stream }: { stream: LiveStream }) {
  const { t } = useI18n()
  const body = useRef<HTMLDivElement>(null)
  const text = useTypewriter(stream.text)
  const lines = text.split('\n')

  useEffect(() => {
    if (body.current !== null) body.current.scrollTop = body.current.scrollHeight
  }, [text])

  return (
    <div className="panel code live">
      <div className="panel-head">
        <span className="file-tab">
          <span className="live-badge">LIVE</span>
          <span className="file-name">{stream.path === null ? stream.tool : baseName(stream.path)}</span>
        </span>
        <span className="file-path">
          {stream.tool} · {t('live.writing')}
        </span>
      </div>
      <div className="panel-body" ref={body}>
        {lines.map((line, index) => (
          <LiveRow key={index} number={stream.skippedLines + index + 1} line={line} language={stream.language} caret={index === lines.length - 1} />
        ))}
      </div>
    </div>
  )
}

// Claude's reply as it is being written, for the home screen.
export function LiveReplyView({ stream }: { stream: LiveStream }) {
  const { t } = useI18n()
  const body = useRef<HTMLDivElement>(null)
  const text = useTypewriter(stream.text)

  useEffect(() => {
    if (body.current !== null) body.current.scrollTop = body.current.scrollHeight
  }, [text])

  return (
    <div className="panel text live">
      <div className="panel-head">
        <span className="file-tab">
          <span className="live-badge">LIVE</span>
          <span className="file-name">{t('home.reply')}</span>
        </span>
        <span className="file-path">{t('live.replying')}</span>
      </div>
      <div className="panel-body prose" ref={body}>
        <Markdown text={`${text}▍`} />
      </div>
    </div>
  )
}

export function ImageView({ preview, compact }: { preview: ImagePreview; compact: boolean }) {
  const connection = useContext(ConnectionContext)

  return (
    <div className={`panel image ${compact ? 'compact' : ''}`}>
      <div className="panel-head">
        <span className="file-tab">
          <span className="lang-badge">IMG</span>
          <span className="file-name">{preview.name}</span>
        </span>
      </div>
      <div className="image-body">
        <RemoteImage key={preview.imageId} connection={connection} id={preview.imageId} alt={preview.name} retry />
      </div>
    </div>
  )
}

export function PreviewView({ preview, cwd, running, compact = false }: { preview: Preview; cwd: string; running: boolean; compact?: boolean }) {
  switch (preview.type) {
    case 'code':
      return <CodeView preview={preview} cwd={cwd} compact={compact} />
    case 'terminal':
      return <TerminalView preview={preview} running={running} compact={compact} />
    case 'text':
      return <TextView preview={preview} compact={compact} />
    case 'todos':
      return <TodoView preview={preview} compact={compact} />
    case 'image':
      return <ImageView preview={preview} compact={compact} />
  }
}

export function MessageView({ title, text }: { title: string; text: string }) {
  return (
    <div className="panel text">
      <div className="panel-head">
        <span className="file-tab plain">
          <span className="file-name">{title}</span>
        </span>
      </div>
      <div className="panel-body prose">
        <Markdown text={text} />
      </div>
    </div>
  )
}
