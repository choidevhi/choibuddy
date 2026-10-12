import type { ChatMessage, PromptMode } from '../../shared/protocol.ts'

// A prompt on its way into the conversation: sent from this pane, waiting
// in the bridge's queue, then taken by Claude Code. It stays one bubble the
// whole way, until the transcript shows the same words, so nothing blinks
// out between the queue and the transcript.
export type OutPrompt = {
  key: string
  text: string
  mode: PromptMode | null
  // How many user messages already held these words when it went out: the
  // transcript has it once one more does.
  seen: number
  at: number
  // Whether the queue has listed it yet.
  listed: boolean
  // When Claude Code took it from the queue; null while sending or queued.
  leftAt: number | null
}

export type Queued = { text: string; mode: PromptMode }

// A prompt just sent waits this long for the queue to list it.
export const SENDING_MS = 3000

// A taken prompt waits this long for the transcript, then goes anyway.
export const SENT_HOLD_MS = 30_000

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// How many user messages hold these words (prompts sent while Claude was
// busy can arrive joined into one).
export function timesSaid(messages: readonly ChatMessage[], text: string): number {
  const wanted = flat(text)
  let count = 0

  for (const message of messages) {
    if (message.role === 'user' && flat(message.text).includes(wanted)) count += 1
  }

  return count
}

// Whether the transcript has caught up with a prompt that left the queue.
// Checked while drawing too, so the transcript's bubble and this one never
// show together for a frame.
export function arrived(item: OutPrompt, queued: readonly Queued[], messages: readonly ChatMessage[] | null): boolean {
  return messages !== null && !queued.some(entry => entry.text === item.text) && timesSaid(messages, item.text) > item.seen
}

export function outPrompt(key: string, text: string, mode: PromptMode | null, messages: readonly ChatMessage[] | null, now: number): OutPrompt {
  return { key, text, mode, seen: messages === null ? 0 : timesSaid(messages, text), at: now, listed: false, leftAt: null }
}

// Lines the outbox up with the queue and the transcript: prompts still
// queued stay queued, ones that left the queue show as sent until the
// transcript has them, and queued prompts sent from elsewhere join. Returns
// the same array when nothing changed.
export function syncOutbox(outbox: OutPrompt[], queued: readonly Queued[], messages: readonly ChatMessage[] | null, now: number, newKey: () => string): OutPrompt[] {
  const waiting = [...queued]
  const next: OutPrompt[] = []
  let changed = false

  for (const item of outbox) {
    const index = waiting.findIndex(entry => entry.text === item.text)

    if (index !== -1) {
      const [entry] = waiting.splice(index, 1)
      const mode = entry?.mode ?? item.mode
      // Still queued, so not in the transcript yet: count from what it holds now.
      const seen = messages === null ? item.seen : timesSaid(messages, item.text)
      const same = item.listed && item.leftAt === null && item.mode === mode && item.seen === seen

      next.push(same ? item : { ...item, mode, seen, listed: true, leftAt: null })
      changed ||= !same

      continue
    }

    if (arrived(item, queued, messages)) {
      changed = true

      continue
    }

    if (!item.listed && now - item.at < SENDING_MS) {
      next.push(item)

      continue
    }

    const leftAt = item.leftAt ?? now

    if (now - leftAt >= SENT_HOLD_MS) {
      changed = true

      continue
    }

    next.push(leftAt === item.leftAt ? item : { ...item, leftAt })
    changed ||= leftAt !== item.leftAt
  }

  for (const entry of waiting) {
    next.push({ ...outPrompt(newKey(), entry.text, entry.mode, messages, now), listed: true })
    changed = true
  }

  return changed ? next : outbox
}
