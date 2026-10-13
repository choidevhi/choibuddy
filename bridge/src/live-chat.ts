// The live part of every open conversation, in one ordered stream: what the
// transcript gained (as patches from a message index on) and the reply being
// written (one draft per session). Both go out on the same SSE connection in
// the order they happened, so a screen only ever appends: it never guesses
// which streamed text became which transcript message, and a reply never
// leaves the screen before the transcript holds it.
import type { ChatDraft, ChatMessage, ChatPatch, ChatRole } from '../../shared/protocol.ts'

// The most a patch carries; a screen further behind reads the page again.
const MAX_PATCH = 200
// A session seen for the first time sends its last messages, so a screen
// that read the page a moment before misses nothing in between.
const FIRST_PATCH = 50
// A draft whose step ended but whose text never reached the transcript (the
// turn was stopped, the file is elsewhere) goes after this long.
const ORPHAN_MS = 30_000
// Every this many updates a draft goes out whole, so a screen that missed
// one catches up without waiting for the next reply.
const FULL_EVERY = 25
// How much of a draft is compared with the transcript: all of it, short of
// where the transcript reader clips a long message.
const PROBE_CHARS = 19_000
// What an older mod's pieces are filed under: it names no step.
export const LEGACY = 'legacy'

// The conversation's last messages as Claude Code holds them, sent by the
// mod after each step: what the transcript file should have.
export type EngineMessage = { role: ChatRole; text: string }

// The transcript, plus the messages Claude Code has that the file does not
// yet (it can lag, or stop being written). They follow the last transcript
// message found in the engine's list; with none found nothing is added.
export function withEngineTail(messages: readonly ChatMessage[], tail: readonly EngineMessage[], now: number): readonly ChatMessage[] {
  if (tail.length === 0) return messages

  const last = messages.at(-1)

  if (last === undefined) return messages

  const lastText = squash(last.text)
  // A reply the transcript joined from several blocks ends with the engine's last block.
  const at = tail.findLastIndex(item => item.role === last.role && squash(item.text) !== '' && lastText.endsWith(squash(item.text)))

  if (at === -1 || at === tail.length - 1) return messages

  return [...messages, ...tail.slice(at + 1).map((item, index) => ({ id: `engine-${messages.length + index}`, role: item.role, text: item.text, at: now }))]
}

export type LiveChatDeps = {
  // The session's messages as the transcript has them now (read again on
  // each call), or null when it has no transcript yet.
  messages: (sessionId: string) => readonly ChatMessage[] | null
  emit: (event: 'chat' | 'draft', data: string) => void
  now: () => number
}

type Sent = { total: number; lastId: string; lastText: string }

type Draft = {
  key: string
  seq: number
  text: string
  // The transcript's message count when the draft began: its reply lands at
  // this index, or grows the message just before it (then that message's
  // text changed from `before`).
  base: number
  before: string
  // The step ended; `answer` is the whole reply (null: not told, an older mod).
  doneAt: number | null
  answer: string | null
  updates: number
  sentText: string
}

// Whitespace differs between the stream (blocks run together) and the
// transcript (blocks joined by blank lines), so neither counts.
function squash(text: string): string {
  return text.replace(/\s+/g, '')
}

export class LiveChats {
  readonly #deps: LiveChatDeps
  readonly #sent = new Map<string, Sent>()
  readonly #drafts = new Map<string, Draft>()
  // The key of the draft each session settled last.
  readonly #settled = new Map<string, string>()
  readonly #engine = new Map<string, readonly EngineMessage[]>()

  constructor(deps: LiveChatDeps) {
    this.#deps = deps
  }

  // A piece of the reply being written. `seq` orders pieces that may arrive
  // out of order; null (older mods) takes arrival order.
  write(sessionId: string, key: string, seq: number | null, text: string): void {
    const current = this.#drafts.get(sessionId)

    if (current !== undefined && current.key === key && seq !== null && seq <= current.seq) return

    // A late piece of a reply that already settled.
    if (current === undefined && this.#settled.get(sessionId) === key && key !== LEGACY) return

    if (current === undefined || current.key !== key) {
      // The step before may still be on its way into the transcript.
      this.sync(sessionId)

      const messages = this.#messages(sessionId) ?? []
      const base = messages.length
      const probe = squash(text).slice(0, PROBE_CHARS)

      // Already in the transcript (an older mod repeats its last text).
      if (probe !== '' && messages.slice(-3).some(message => message.role === 'assistant' && squash(message.text).includes(probe))) return

      this.#drafts.set(sessionId, { key, seq: seq ?? 0, text, base, before: messages.at(-1)?.text ?? '', doneAt: null, answer: null, updates: 0, sentText: '' })
    } else {
      current.seq = seq ?? current.seq + 1
      current.text = text
    }

    this.#sendDraft(sessionId)
    this.sync(sessionId)
  }

  // The step is over: `answer` is its whole visible reply.
  finish(sessionId: string, key: string, answer: string): void {
    const draft = this.#drafts.get(sessionId)

    if (draft === undefined || draft.key !== key) return

    draft.doneAt = this.#deps.now()
    draft.answer = answer
    this.sync(sessionId)
  }

  // The turn ended or the session went away: whatever is left is read from
  // the transcript first, then the draft goes.
  end(sessionId: string): void {
    const draft = this.#drafts.get(sessionId)

    if (draft === undefined || draft.doneAt !== null) return

    draft.doneAt = this.#deps.now()
    this.sync(sessionId)
  }

  // Claude Code's own last messages, from the mod.
  engine(sessionId: string, tail: readonly EngineMessage[]): void {
    this.#engine.set(sessionId, tail)
    this.sync(sessionId)
  }

  forget(sessionId: string): void {
    this.#engine.delete(sessionId)
    this.#sent.delete(sessionId)
    this.#settled.delete(sessionId)
    if (this.#drafts.delete(sessionId)) this.#clear(sessionId)
  }

  // Reads each listed session's transcript and sends what changed.
  tick(sessionIds: Iterable<string>): void {
    const listed = new Set(sessionIds)

    for (const sessionId of listed) this.sync(sessionId)

    for (const sessionId of [...this.#drafts.keys()]) if (!listed.has(sessionId)) this.sync(sessionId)
  }

  // One session: the transcript's news as a patch, then the draft goes if
  // the transcript holds it now. Until then the reply's part already in the
  // transcript stays out of the patches: it shows once, as the draft.
  sync(sessionId: string): void {
    const messages = this.#messages(sessionId)

    if (messages === null) return

    const gone = this.#gone(sessionId, messages)
    const patch = this.#patch(sessionId, gone ? messages : this.#view(sessionId, messages))

    if (patch !== null) this.#deps.emit('chat', JSON.stringify(patch))

    if (!gone) return

    this.#settled.set(sessionId, this.#drafts.get(sessionId)?.key ?? '')
    this.#drafts.delete(sessionId)
    this.#clear(sessionId)
  }

  #messages(sessionId: string): readonly ChatMessage[] | null {
    const messages = this.#deps.messages(sessionId)

    return messages === null ? null : withEngineTail(messages, this.#engine.get(sessionId) ?? [], this.#deps.now())
  }

  // What a screen that just connected needs: every draft, whole.
  drafts(): ChatDraft[] {
    return [...this.#drafts].map(([sessionId, draft]) => ({ sessionId, key: draft.key, text: draft.text, append: null, offset: 0, at: this.#deps.now() }))
  }

  #patch(sessionId: string, messages: readonly ChatMessage[]): ChatPatch | null {
    const sent = this.#sent.get(sessionId)
    const total = messages.length
    const last = messages.at(-1)
    const now: Sent = { total, lastId: last?.id ?? '', lastText: last?.text ?? '' }

    this.#sent.set(sessionId, now)

    if (sent === undefined) {
      const from = Math.max(0, total - FIRST_PATCH)

      return { sessionId, from, messages: messages.slice(from), total, reset: false }
    }

    if (sent.total === total && sent.lastId === now.lastId && sent.lastText === now.lastText) return null

    if (total < sent.total) return { sessionId, from: 0, messages: [], total, reset: true }

    // The message that was last may have grown (more blocks of one reply).
    const grown = sent.total > 0 && messages[sent.total - 1]?.id === sent.lastId && messages[sent.total - 1]?.text !== sent.lastText
    const from = grown ? sent.total - 1 : sent.total

    if (total - from > MAX_PATCH) return { sessionId, from: 0, messages: [], total, reset: true }

    return { sessionId, from, messages: messages.slice(from), total, reset: false }
  }

  // The draft is done with: the transcript holds all of it, its step ended
  // with no words, or it never reached the transcript.
  #gone(sessionId: string, messages: readonly ChatMessage[]): boolean {
    const draft = this.#drafts.get(sessionId)

    if (draft === undefined) return false

    const probe = squash(draft.answer ?? draft.text).slice(0, PROBE_CHARS)
    const grown = messages[draft.base - 1]
    const candidates = grown !== undefined && grown.text !== draft.before ? messages.slice(draft.base - 1) : messages.slice(draft.base)
    const landed = probe !== '' && candidates.some(message => message.role === 'assistant' && squash(message.text).includes(probe))
    const empty = draft.doneAt !== null && probe === ''
    const orphan = draft.doneAt !== null && this.#deps.now() - draft.doneAt > ORPHAN_MS

    return landed || empty || orphan
  }

  // The transcript without the part of the draft's reply it has so far (the
  // reply's first blocks, before the rest is written).
  #view(sessionId: string, messages: readonly ChatMessage[]): readonly ChatMessage[] {
    const draft = this.#drafts.get(sessionId)

    if (draft === undefined) return messages

    const said = squash(draft.answer ?? draft.text)
    const before = squash(draft.before)

    for (let index = Math.max(0, draft.base - 1); index < messages.length; index += 1) {
      const message = messages[index]

      if (message === undefined || message.role !== 'assistant') continue

      const text = squash(message.text)

      // The message before the draft, grown by the reply's first blocks.
      if (index === draft.base - 1) {
        const rest = text.slice(before.length)

        if (rest !== '' && text.startsWith(before) && said.startsWith(rest)) return [...messages.slice(0, index), { ...message, text: draft.before }]

        continue
      }

      if (text !== '' && said.startsWith(text)) return messages.slice(0, index)
    }

    return messages
  }

  #sendDraft(sessionId: string): void {
    const draft = this.#drafts.get(sessionId)

    if (draft === undefined) return

    const at = this.#deps.now()
    const grows = draft.sentText !== '' && draft.text.startsWith(draft.sentText) && draft.updates % FULL_EVERY !== 0

    if (draft.text === draft.sentText) return

    const message: ChatDraft = grows
      ? { sessionId, key: draft.key, text: null, append: draft.text.slice(draft.sentText.length), offset: draft.sentText.length, at }
      : { sessionId, key: draft.key, text: draft.text, append: null, offset: 0, at }

    draft.updates += 1
    draft.sentText = draft.text
    this.#deps.emit('draft', JSON.stringify(message))
  }

  #clear(sessionId: string): void {
    const message: ChatDraft = { sessionId, key: '', text: null, append: null, offset: 0, at: this.#deps.now() }

    this.#deps.emit('draft', JSON.stringify(message))
  }
}
