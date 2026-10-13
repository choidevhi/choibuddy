import type { ChatDraft, ChatPatch, Conversation } from '../../shared/protocol.ts'

// The pure part of the live conversation: reading the bridge's "chat" and
// "draft" events and applying them (tested in ui/test).

// The reply a screen shows for a session while it is being written.
export type Held = { key: string; text: string }

export function parseDraft(text: string): ChatDraft | null {
  try {
    const value: ChatDraft = JSON.parse(text)

    return typeof value.sessionId === 'string' && typeof value.key === 'string' && typeof value.offset === 'number' ? value : null
  } catch {
    return null
  }
}

export function parsePatch(text: string): ChatPatch | null {
  try {
    const value: ChatPatch = JSON.parse(text)

    return typeof value.sessionId === 'string' && typeof value.from === 'number' && Array.isArray(value.messages) ? value : null
  } catch {
    return null
  }
}

// The draft after `draft` arrives: grown, replaced, or gone (null).
export function nextDraft(current: Held | undefined, draft: ChatDraft): Held | null | undefined {
  if (draft.append !== null) {
    // A piece for another reply, or one after a missed piece: keep what is
    // shown until the next whole text.
    if (current === undefined || current.key !== draft.key || current.text.length !== draft.offset) return current

    return { key: draft.key, text: current.text + draft.append }
  }

  return draft.text === null ? null : { key: draft.key, text: draft.text }
}

// The conversation with `patch` applied; null when it cannot be (the page
// must be read again: the transcript was rewritten, or messages were missed).
export function patchConversation(conversation: Conversation, patch: ChatPatch): Conversation | null {
  const end = conversation.start + conversation.messages.length

  if (patch.reset || patch.from > end) return null

  const keep = conversation.messages.slice(0, Math.max(0, patch.from - conversation.start))
  const added = patch.messages.slice(Math.max(0, conversation.start - patch.from))

  return { ...conversation, messages: [...keep, ...added], total: patch.total }
}
