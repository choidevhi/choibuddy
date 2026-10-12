// Conversations come from Claude Code's own transcript files, so the whole
// history of a session is there (also from before the bridge started) and
// past sessions can be opened too.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ChatRole, Conversation, HistoryEntry } from '../../shared/protocol.ts'
import { bool, type Json, type JsonObject, obj, objects, parseJsonObject, str } from './json.ts'
import { baseName } from './previews.ts'
import { moveInto } from './trash.ts'

const SYSTEM_TAGS = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|task-notification)>[\s\S]*?<\/\1>/g
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
const MAX_TEXT = 20_000
const HEAD_BYTES = 96 * 1024
const TAIL_BYTES = 96 * 1024

function stamp(line: JsonObject): number {
  const parsed = Date.parse(str(line, 'timestamp') ?? '')

  return Number.isFinite(parsed) ? parsed : 0
}

// What a person typed, without the wrapping Claude Code adds: system
// reminders and command output go, a slash command reads as "/name args".
export function userText(content: string): string | null {
  const command = COMMAND_NAME.exec(content)

  if (command?.[1] !== undefined) {
    const args = COMMAND_ARGS.exec(content)?.[1]?.trim() ?? ''

    return `${command[1].trim()}${args === '' ? '' : ` ${args}`}`
  }

  const text = content.replace(SYSTEM_TAGS, '').trim()

  return text === '' ? null : text
}

function textBlocks(content: Json | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return objects(content)
    .flatMap(block => (str(block, 'type') === 'text' ? [str(block, 'text') ?? ''] : []))
    .join('\n\n')
}

type Pending = {
  messageId: string | null
}

// Turns transcript lines into chat messages. Assistant replies streamed as
// several lines with the same message id are joined.
export class TranscriptReader {
  readonly messages: ChatMessage[] = []
  title: string | null = null
  cwd: string | null = null
  #offset = 0
  #remainder = ''
  #last: Pending = { messageId: null }
  #firstPrompt: string | null = null

  // Reads what was appended since the last call.
  update(path: string): void {
    let size: number

    try {
      size = statSync(path).size
    } catch {
      return
    }

    if (size < this.#offset) this.#reset()
    if (size === this.#offset) return

    const fd = openSync(path, 'r')

    try {
      const length = size - this.#offset
      const buffer = Buffer.alloc(length)

      readSync(fd, buffer, 0, length, this.#offset)
      this.#offset = size
      this.#feed(this.#remainder + buffer.toString('utf8'))
    } finally {
      closeSync(fd)
    }
  }

  #reset(): void {
    this.messages.length = 0
    this.title = null
    this.cwd = null
    this.#offset = 0
    this.#remainder = ''
    this.#last = { messageId: null }
    this.#firstPrompt = null
  }

  // Parses a slice of a transcript (whole lines; a cut-off first or last
  // line is skipped). Used for quick looks at the start and end of a file.
  feedText(text: string): void {
    for (const line of text.split('\n')) {
      const parsed = line.trim() === '' ? null : parseJsonObject(line)

      if (parsed !== null) this.#line(parsed)
    }
  }

  #feed(text: string): void {
    const lines = text.split('\n')

    // A line still being written stays for the next read.
    this.#remainder = lines.pop() ?? ''

    for (const line of lines) {
      const parsed = line.trim() === '' ? null : parseJsonObject(line)

      if (parsed !== null) this.#line(parsed)
    }
  }

  #push(role: ChatRole, text: string, at: number, id: string, messageId: string | null): void {
    const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
    const last = this.messages.at(-1)

    if (role === 'assistant' && messageId !== null && last?.role === 'assistant' && this.#last.messageId === messageId) {
      last.text = `${last.text}\n\n${clipped}`
      return
    }

    this.messages.push({ id, role, text: clipped, at })
    this.#last = { messageId: role === 'assistant' ? messageId : null }
  }

  #line(line: JsonObject): void {
    const type = str(line, 'type')

    this.cwd ??= str(line, 'cwd')

    if (type === 'custom-title') this.title = str(line, 'customTitle') ?? str(line, 'title') ?? this.title
    if (type === 'ai-title' && this.title === null) this.title = str(line, 'aiTitle')
    if (type === 'summary' && this.title === null) this.title = str(line, 'summary')
    if (bool(line, 'isSidechain') === true || bool(line, 'isMeta') === true) return

    const message = obj(line, 'message')
    const id = str(line, 'uuid') ?? `${this.messages.length}`

    if (type === 'user' && bool(line, 'isCompactSummary') === true) {
      // The summary Claude Code writes when it compacts is not something the
      // person typed: it shows as a quiet marker instead of a huge bubble.
      this.#push('note', 'compacted', stamp(line), id, null)
      return
    }

    if (type === 'user') {
      const content = message?.content
      // Tool results come back as user lines; only typed text counts.
      const hasToolResult = Array.isArray(content) && objects(content).some(block => str(block, 'type') === 'tool_result')
      const text = hasToolResult ? null : userText(textBlocks(content))

      if (text === null) return

      this.#firstPrompt ??= text
      this.#push('user', text, stamp(line), id, null)
      return
    }

    if (type === 'assistant') {
      const text = textBlocks(message?.content).trim()

      if (text !== '') this.#push('assistant', text, stamp(line), id, str(message, 'id'))
    }
  }

  get bestTitle(): string {
    return this.title ?? this.#firstPrompt?.slice(0, 80) ?? ''
  }
}

export class Transcripts {
  readonly #projectsDir: string
  readonly #readers = new Map<string, TranscriptReader>()

  constructor(projectsDir: string) {
    this.#projectsDir = projectsDir
  }

  // Where a session's transcript is: the path a hook reported, or a search
  // of the project folders by session id.
  find(sessionId: string, known: string | null): string | null {
    if (known !== null && known !== '') return known
    if (!/^[\w-]+$/.test(sessionId)) return null

    for (const dir of this.#projectDirs()) {
      const candidate = join(dir, `${sessionId}.jsonl`)

      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not in this project.
      }
    }

    return null
  }

  #projectDirs(): string[] {
    try {
      return readdirSync(this.#projectsDir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? [join(this.#projectsDir, entry.name)] : []))
    } catch {
      return []
    }
  }

  // Moves a session's transcript (and its subagents' folder) into `trashDir`
  // instead of deleting it, so a slip can be undone by hand.
  trash(sessionId: string, trashDir: string, now: number): boolean {
    const path = this.find(sessionId, null)

    if (path === null) return false

    const target = join(trashDir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${sessionId}`)
    const companion = path.slice(0, -'.jsonl'.length)

    mkdirSync(target, { recursive: true })
    moveInto(path, target)
    if (existsSync(companion)) moveInto(companion, target)
    this.#readers.delete(path)

    return true
  }

  reader(path: string): TranscriptReader {
    const existing = this.#readers.get(path)
    const reader = existing ?? new TranscriptReader()

    if (existing === undefined) this.#readers.set(path, reader)
    reader.update(path)

    return reader
  }

  // The last `limit` messages (before `before`), or everything from `from`
  // on: a screen that already shows a conversation asks from where it starts,
  // so new messages add to the end and nothing slides off the top.
  conversation(sessionId: string, path: string, before: number | null, limit: number, from: number | null = null): Conversation {
    const reader = this.reader(path)
    const end = Math.min(before ?? reader.messages.length, reader.messages.length)
    const start = from === null ? Math.max(0, end - limit) : Math.min(Math.max(0, from), end)

    return { sessionId, title: reader.bestTitle, messages: reader.messages.slice(start, end), start, total: reader.messages.length }
  }

  // Recent sessions on disk, newest first. Titles come from the start and end
  // of each file only, so listing stays fast with large transcripts.
  recent(limit: number, maxAgeMs: number, now: number): HistoryEntry[] {
    const files: Array<{ path: string; sessionId: string; mtime: number }> = []

    for (const dir of this.#projectDirs()) {
      let names: string[] = []

      try {
        names = readdirSync(dir)
      } catch {
        names = []
      }

      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue

        try {
          const path = join(dir, name)
          const mtime = statSync(path).mtimeMs

          if (now - mtime <= maxAgeMs) files.push({ path, sessionId: name.slice(0, -'.jsonl'.length), mtime })
        } catch {
          // Removed while listing.
        }
      }
    }

    return files
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(file => {
        const glance = glanceAt(file.path)
        const cwd = glance.cwd ?? ''

        return { sessionId: file.sessionId, project: cwd === '' ? '' : baseName(cwd), cwd, title: glance.title, updatedAt: file.mtime, live: false }
      })
  }
}

function readSlice(path: string, from: number, length: number): string {
  const fd = openSync(path, 'r')

  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, from)

    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function glanceAt(path: string): { title: string; cwd: string | null } {
  let size = 0

  try {
    size = statSync(path).size
  } catch {
    return { title: '', cwd: null }
  }

  const reader = new TranscriptReader()

  reader.feedText(readSlice(path, 0, Math.min(size, HEAD_BYTES)))
  if (size > HEAD_BYTES) reader.feedText(`
${readSlice(path, Math.max(HEAD_BYTES, size - TAIL_BYTES), Math.min(TAIL_BYTES, size - HEAD_BYTES))}`)

  return { title: reader.bestTitle, cwd: reader.cwd }
}

// The folder a session was last in: the newest line near the end that names
// one (Claude moves between folders as it works). Null when none is found.
export function lastCwd(path: string): string | null {
  let size = 0

  try {
    size = statSync(path).size
  } catch {
    return null
  }

  const lines = readSlice(path, Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)).split('\n')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cwd = str(parseJsonObject(lines[index] ?? ''), 'cwd')

    if (cwd !== null && cwd !== '') return cwd
  }

  return null
}
