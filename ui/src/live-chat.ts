import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ChatDraft, ChatPatch } from '../../shared/protocol.ts'
import { type Held, nextDraft } from './chat-patch.ts'

// What every bridge pushes about open conversations (SSE "chat" and
// "draft"), kept outside React state: only the pane showing a session
// redraws when its conversation moves, not the whole app.

const drafts = new Map<string, Held>()
const draftListeners = new Set<() => void>()
const patchListeners = new Map<string, Set<(patch: ChatPatch) => void>>()
// Bumped each time a bridge's stream (re)opens: screens read the page again,
// since what happened while it was down never comes as patches.
const epochs = new Map<string, number>()
const epochListeners = new Set<() => void>()

const idOf = (feedKey: string, sessionId: string): string => `${feedKey}|${sessionId}`

function notify(listeners: Set<() => void>): void {
  for (const listener of listeners) listener()
}

export function applyDraft(feedKey: string, draft: ChatDraft): void {
  const id = idOf(feedKey, draft.sessionId)
  const current = drafts.get(id)
  const next = nextDraft(current, draft)

  if (next === current) return

  if (next === null || next === undefined) drafts.delete(id)
  else drafts.set(id, next)
  notify(draftListeners)
}

export function applyChat(feedKey: string, patch: ChatPatch): void {
  for (const listener of patchListeners.get(idOf(feedKey, patch.sessionId)) ?? []) listener(patch)
}

// The bridge's stream opened again: it sends its drafts anew.
export function reopened(feedKey: string): void {
  for (const id of [...drafts.keys()]) if (id.startsWith(`${feedKey}|`)) drafts.delete(id)
  epochs.set(feedKey, (epochs.get(feedKey) ?? 0) + 1)
  notify(draftListeners)
  notify(epochListeners)
}

// The reply this session is writing now, or null.
export function useDraft(feedKey: string | null, sessionId: string | null): string | null {
  return useSyncExternalStore(
    listener => {
      draftListeners.add(listener)

      return () => draftListeners.delete(listener)
    },
    () => (feedKey === null || sessionId === null ? null : (drafts.get(idOf(feedKey, sessionId))?.text ?? null)),
  )
}

export function useEpoch(feedKey: string | null): number {
  return useSyncExternalStore(
    listener => {
      epochListeners.add(listener)

      return () => epochListeners.delete(listener)
    },
    () => (feedKey === null ? 0 : (epochs.get(feedKey) ?? 0)),
  )
}

// Calls `onPatch` with each change of this session's conversation.
export function usePatches(feedKey: string | null, sessionId: string | null, onPatch: (patch: ChatPatch) => void): void {
  const handler = useRef(onPatch)

  handler.current = onPatch

  useEffect(() => {
    if (feedKey === null || sessionId === null) return

    const id = idOf(feedKey, sessionId)
    const listener = (patch: ChatPatch): void => handler.current(patch)
    const set = patchListeners.get(id) ?? new Set()

    set.add(listener)
    patchListeners.set(id, set)

    return () => {
      set.delete(listener)
      if (set.size === 0) patchListeners.delete(id)
    }
  }, [feedKey, sessionId])
}
