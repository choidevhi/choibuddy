// What was typed into each session's prompt box and not sent yet, so moving
// to another session and back finds it again (also after the app restarts).
// Kept in this device's storage only; the PC never sees a draft.

export type DraftFile = { name: string; path: string }

export type Draft = { text: string; files: DraftFile[]; at: number }

// The stored form, checked field by field when read back.
type Stored = Record<string, { text?: string; files?: Array<{ name?: string; path?: string }>; at?: number } | null>

const KEY = 'choibuddy.drafts'
const KEEP = 60
const KEEP_MS = 14 * 24 * 60 * 60_000

function readAll(): Map<string, Draft> {
  const drafts = new Map<string, Draft>()

  try {
    const stored: Stored = JSON.parse(localStorage.getItem(KEY) ?? '{}')

    for (const [sessionId, value] of Object.entries(stored)) {
      if (typeof value?.text !== 'string' || typeof value.at !== 'number') continue

      const files: DraftFile[] = []

      for (const file of Array.isArray(value.files) ? value.files : []) {
        if (typeof file?.name === 'string' && typeof file.path === 'string') files.push({ name: file.name, path: file.path })
      }

      drafts.set(sessionId, { text: value.text, files, at: value.at })
    }
  } catch {
    // A broken or blocked store starts empty.
  }

  return drafts
}

function writeAll(drafts: Map<string, Draft>): void {
  const cutoff = Date.now() - KEEP_MS
  // The newest ones are kept; old or surplus drafts go.
  const kept = [...drafts.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, KEEP)

  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept.filter(([, draft]) => draft.at > cutoff))))
  } catch {
    // Drafts are a convenience; typing works without storage.
  }
}

export function readDraft(sessionId: string): Draft | null {
  return readAll().get(sessionId) ?? null
}

// An empty box removes the session's draft.
export function saveDraft(sessionId: string, text: string, files: DraftFile[]): void {
  const drafts = readAll()

  if (text.trim() === '' && files.length === 0) drafts.delete(sessionId)
  else drafts.set(sessionId, { text, files, at: Date.now() })
  writeAll(drafts)
}
