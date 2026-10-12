import { createContext } from 'react'
import type { CommandInfo, Conversation, Decision, DeviceInfo, DocFile, DocGroup, GalleryImage, HistoryEntry, Project, PromptMode } from '../../shared/protocol.ts'
import type { Connection } from './platform.ts'

export type LinkState = 'connecting' | 'live' | 'offline' | 'unauthorized'

export async function sendDecision(connection: Connection, decision: Decision): Promise<'ok' | 'gone' | 'failed'> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/decide`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(decision),
    })

    if (res.status === 404) return 'gone'

    return res.ok ? 'ok' : 'failed'
  } catch {
    return 'failed'
  }
}

export async function dismissSession(connection: Connection, sessionId: string): Promise<void> {
  await fetch(`${connection.baseUrl}/api/dismiss`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).catch(() => undefined)
}

// Stops the session's running turn, as Esc does in its terminal.
export async function stopSession(connection: Connection, sessionId: string): Promise<'ok' | 'old-mod' | 'failed'> {
  const res = await post(connection, '/api/sessions/stop', { sessionId })

  if (res?.ok === true) return 'ok'

  const body: { error?: string } | null = res === null ? null : await res.json().catch(() => null)

  return body?.error === 'old-mod' ? 'old-mod' : 'failed'
}

export async function sendPrompt(connection: Connection, sessionId: string, text: string, mode: PromptMode): Promise<'queued' | 'no-mod' | 'failed'> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/prompt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text, mode }),
    })

    if (res.ok) return 'queued'

    return res.status === 409 ? 'no-mod' : 'failed'
  } catch {
    return 'failed'
  }
}

// The bridge connection for parts deep in the tree (image URLs, gallery).
export const ConnectionContext = createContext<Connection | null>(null)

export function imageUrl(connection: Connection, id: string): string {
  return `${connection.baseUrl}/api/image/${encodeURIComponent(id)}?token=${encodeURIComponent(connection.token)}`
}

// The bridge builds this list itself from the same protocol file.
export async function fetchGallery(connection: Connection): Promise<GalleryImage[]> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/gallery`, { headers: { Authorization: `Bearer ${connection.token}` } })
    const body: { images?: GalleryImage[] } = await res.json()

    return Array.isArray(body.images) ? body.images : []
  } catch {
    return []
  }
}

export async function fetchHistory(connection: Connection): Promise<HistoryEntry[]> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/history`, { headers: { Authorization: `Bearer ${connection.token}` } })
    const body: { sessions?: HistoryEntry[] } = await res.json()

    return Array.isArray(body.sessions) ? body.sessions : []
  } catch {
    return []
  }
}

// The last `limit` messages, or (with `from`) every message from that index on.
export async function fetchConversation(connection: Connection, sessionId: string, limit: number, from: number | null = null): Promise<Conversation | null> {
  try {
    const query = `session=${encodeURIComponent(sessionId)}&limit=${limit}${from === null ? '' : `&from=${from}`}`
    const res = await fetch(`${connection.baseUrl}/api/conversation?${query}`, { headers: { Authorization: `Bearer ${connection.token}` } })

    if (!res.ok) return null

    const body: Conversation = await res.json()

    return Array.isArray(body.messages) ? body : null
  } catch {
    return null
  }
}

const ownerHeaders = (connection: Connection): Record<string, string> => ({ Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' })

// Devices paired with this PC, or null when the code in hand is a device's
// own (only the PC's own code may list and manage devices).
export async function listDevices(connection: Connection): Promise<DeviceInfo[] | null> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/devices`, { headers: ownerHeaders(connection) })

    if (!res.ok) return null

    const body: { devices?: DeviceInfo[] } = await res.json()

    return Array.isArray(body.devices) ? body.devices : []
  } catch {
    return null
  }
}

export async function createDevice(connection: Connection): Promise<string | null> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/devices`, { method: 'POST', headers: ownerHeaders(connection) })
    const body: { token?: string } = await res.json()

    return typeof body.token === 'string' ? body.token : null
  } catch {
    return null
  }
}

export async function revokeDevice(connection: Connection, id: string): Promise<boolean> {
  const res = await fetch(`${connection.baseUrl}/api/devices/revoke`, { method: 'POST', headers: ownerHeaders(connection), body: JSON.stringify({ id }) }).catch(() => null)

  return res?.ok === true
}

export async function rotateCodes(connection: Connection): Promise<boolean> {
  const res = await fetch(`${connection.baseUrl}/api/rotate`, { method: 'POST', headers: ownerHeaders(connection) }).catch(() => null)

  return res?.ok === true
}

export type Uploaded = {
  path: string
  name: string
  size: number
}

// Sends a file to the PC that runs the session; Claude gets its path.
export async function uploadFile(connection: Connection, sessionId: string, file: File): Promise<Uploaded | null> {
  try {
    const name = file.name === '' ? 'pasted.png' : file.name
    const query = `name=${encodeURIComponent(name)}&session=${encodeURIComponent(sessionId)}`
    const res = await fetch(`${connection.baseUrl}/api/upload?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': file.type === '' ? 'application/octet-stream' : file.type },
      body: file,
    })

    if (!res.ok) return null

    const body: Partial<Uploaded> = await res.json()

    return typeof body.path === 'string' ? { path: body.path, name: body.name ?? name, size: body.size ?? file.size } : null
  } catch {
    return null
  }
}

export type SetupStatus = {
  hooks: boolean
  mod: boolean
}

export async function fetchSetup(connection: Connection): Promise<SetupStatus | null> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/setup`, { headers: { Authorization: `Bearer ${connection.token}` } })

    if (!res.ok) return null

    const body: Partial<SetupStatus> = await res.json()

    return { hooks: body.hooks === true, mod: body.mod === true }
  } catch {
    return null
  }
}

// 0 turns Auto Accept off, a negative number keeps it on until turned off.
export async function setAutoAccept(connection: Connection, minutes: number): Promise<boolean> {
  const res = await fetch(`${connection.baseUrl}/api/auto-accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes }),
  }).catch(() => null)

  return res?.ok === true
}

export async function fetchDocs(connection: Connection): Promise<DocGroup[]> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/docs`, { headers: { Authorization: `Bearer ${connection.token}` } })
    const body: { groups?: DocGroup[] } = await res.json()

    return Array.isArray(body.groups) ? body.groups : []
  } catch {
    return []
  }
}

export async function readDoc(connection: Connection, id: string): Promise<{ file: DocFile; text: string } | null> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/docs/file?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${connection.token}` } })
    const body: { file?: DocFile; text?: string } = await res.json()

    return res.ok && body.file !== undefined && typeof body.text === 'string' ? { file: body.file, text: body.text } : null
  } catch {
    return null
  }
}

export type SaveResult = { ok: true; file: DocFile } | { ok: false; conflict: string | null }

export async function writeDoc(connection: Connection, id: string, text: string, mtime: number): Promise<SaveResult> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/docs/file`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text, mtime }),
    })
    const body: { file?: DocFile; current?: string | null } = await res.json()

    if (res.ok && body.file !== undefined) return { ok: true, file: body.file }

    return { ok: false, conflict: res.status === 409 ? (body.current ?? '') : null }
  } catch {
    return { ok: false, conflict: null }
  }
}

const authHeaders = (connection: Connection, json = false): Record<string, string> =>
  json ? { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${connection.token}` }

// Pictures load through fetch with the code in a header, like every other
// call, rather than as a plain <img> URL: that is what works in the phone's
// WebView too. The blob keeps a GIF animated.
export async function fetchImageBlob(connection: Connection, id: string): Promise<Blob | null> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/image/${encodeURIComponent(id)}`, { headers: authHeaders(connection) })

    return res.ok ? await res.blob() : null
  } catch {
    return null
  }
}

export async function deleteImage(connection: Connection, id: string): Promise<boolean> {
  const res = await fetch(`${connection.baseUrl}/api/gallery/delete`, { method: 'POST', headers: authHeaders(connection, true), body: JSON.stringify({ id }) }).catch(() => null)

  return res?.ok === true
}

export async function clearGallery(connection: Connection): Promise<boolean> {
  const res = await fetch(`${connection.baseUrl}/api/gallery/clear`, { method: 'POST', headers: authHeaders(connection, true), body: '{}' }).catch(() => null)

  return res?.ok === true
}

export type DeleteResult = 'deleted' | 'live' | 'failed'

export async function deleteConversation(connection: Connection, sessionId: string): Promise<DeleteResult> {
  const res = await fetch(`${connection.baseUrl}/api/conversation/delete`, {
    method: 'POST',
    headers: authHeaders(connection, true),
    body: JSON.stringify({ sessionId }),
  }).catch(() => null)

  if (res?.ok === true) return 'deleted'

  return res?.status === 409 ? 'live' : 'failed'
}

export async function fetchCommands(connection: Connection, sessionId: string): Promise<CommandInfo[]> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/commands?session=${encodeURIComponent(sessionId)}`, { headers: authHeaders(connection) })
    const body: { commands?: CommandInfo[] } = await res.json()

    return Array.isArray(body.commands) ? body.commands : []
  } catch {
    return []
  }
}

export async function fetchProjects(connection: Connection): Promise<Project[]> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/projects`, { headers: authHeaders(connection) })
    const body: { projects?: Project[] } = await res.json()

    return Array.isArray(body.projects) ? body.projects : []
  } catch {
    return []
  }
}

// `sessionId`: the session that opened, when ChoiBuddy runs it itself (Codex).
export type OpenResult = { ok: true; terminal: string; sessionId: string | null } | { ok: false; error: string }

// The coding agents a new session can start.
export type SessionAgent = 'claude' | 'codex'

// `window`: in a terminal window on the PC; Codex otherwise runs in ChoiBuddy.
export async function openNewSession(connection: Connection, cwd: string, prompt: string, agent: SessionAgent, window: boolean): Promise<OpenResult> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/session/new`, { method: 'POST', headers: authHeaders(connection, true), body: JSON.stringify({ cwd, prompt, agent, window }) })
    const body: { terminal?: string; error?: string; sessionId?: string } = await res.json()

    return res.ok ? { ok: true, terminal: body.terminal ?? '', sessionId: body.sessionId ?? null } : { ok: false, error: body.error ?? String(res.status) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export type BrowserAnswer = { ok: true; url: string; title: string; picked: string | null; image: string | null } | { ok: false; error: string }

export async function answerBrowser(connection: Connection, id: string, answer: BrowserAnswer): Promise<boolean> {
  const res = await fetch(`${connection.baseUrl}/api/browser/answer`, {
    method: 'POST',
    headers: authHeaders(connection, true),
    body: JSON.stringify({ id, ...answer }),
  }).catch(() => null)

  return res?.ok === true
}

async function post(connection: Connection, path: string, body: Record<string, string | number | boolean | string[]>): Promise<Response | null> {
  return fetch(`${connection.baseUrl}${path}`, { method: 'POST', headers: authHeaders(connection, true), body: JSON.stringify(body) }).catch(() => null)
}

// A name given in ChoiBuddy; an empty one goes back to Claude Code's.
export async function renameSession(connection: Connection, sessionId: string, title: string): Promise<boolean> {
  return (await post(connection, '/api/sessions/rename', { sessionId, title }))?.ok === true
}

// Puts ended sessions away under the archive, or brings them back.
export async function archiveSessions(connection: Connection, sessionIds: string[], archived: boolean): Promise<boolean> {
  return (await post(connection, '/api/sessions/archive', { sessionIds, archived }))?.ok === true
}

export type EndResult = 'sent' | 'no-mod' | 'failed'

// Asks Claude Code on the PC to close the session (/exit).
// /reload-plugins in the session, run once it is idle: an older mod picks
// up the installed one.
export async function reloadPlugins(connection: Connection, sessionId: string): Promise<boolean> {
  return (await post(connection, '/api/sessions/reload', { sessionId }))?.ok === true
}

export async function endSession(connection: Connection, sessionId: string): Promise<EndResult> {
  const res = await post(connection, '/api/sessions/end', { sessionId })

  if (res?.ok === true) return 'sent'

  return res?.status === 409 ? 'no-mod' : 'failed'
}

// A terminal window on the PC, in `cwd` (empty: the home folder).
export async function openTerminal(connection: Connection, cwd: string): Promise<boolean> {
  return (await post(connection, '/api/terminal/open', { cwd }))?.ok === true
}

// `trusted`: whether Codex runs the hooks (null: not connected, or Codex
// could not be asked). `cli`: whether the `codex` command is there.
// A model Codex offers, with the efforts it takes.
export type CodexModelChoice = { id: string; name: string; efforts: string[] }

export async function fetchCodexModels(connection: Connection): Promise<CodexModelChoice[]> {
  const res = await fetch(`${connection.baseUrl}/api/codex/models`, { headers: authHeaders(connection) }).catch(() => null)
  const body: { models?: Array<{ id?: string; name?: string; efforts?: string[] }> } | null = res?.ok === true ? await res.json().catch(() => null) : null

  return (body?.models ?? []).flatMap(model => (model.id === undefined ? [] : [{ id: model.id, name: model.name ?? model.id, efforts: model.efforts ?? [] }]))
}

// The model and effort the next turn of a Codex session ChoiBuddy runs
// uses; an empty one stays as it is.
export async function setCodexSettings(connection: Connection, sessionId: string, model: string, effort: string): Promise<boolean> {
  return (await post(connection, '/api/codex/settings', { sessionId, model, effort }))?.ok === true
}

export type CodexState = { installed: boolean; connected: boolean; trusted: boolean | null; cli: boolean }

type CodexBody = { installed?: boolean; connected?: boolean; trusted?: boolean | null; cli?: boolean }

function codexStateOf(body: CodexBody | null): CodexState | null {
  return body === null || typeof body.installed !== 'boolean' || typeof body.connected !== 'boolean'
    ? null
    : { installed: body.installed, connected: body.connected, trusted: typeof body.trusted === 'boolean' ? body.trusted : null, cli: body.cli === true }
}

// Codex on the PC, and whether ChoiBuddy's hooks are in its hooks.json.
export async function fetchCodex(connection: Connection): Promise<CodexState | null> {
  const res = await fetch(`${connection.baseUrl}/api/codex`, { headers: authHeaders(connection) }).catch(() => null)
  const body: CodexBody | null = res?.ok === true ? await res.json().catch(() => null) : null

  return codexStateOf(body)
}

export async function setCodex(connection: Connection, on: boolean): Promise<CodexState | null> {
  const res = await fetch(`${connection.baseUrl}/api/codex`, { method: 'POST', headers: authHeaders(connection, true), body: JSON.stringify({ on }) }).catch(() => null)
  const body: CodexBody | null = res?.ok === true ? await res.json().catch(() => null) : null

  return codexStateOf(body)
}

// Replies in another language are asked again in `lang` (null: off).
export async function setAutoLanguage(connection: Connection, lang: string | null): Promise<boolean> {
  return (await post(connection, '/api/auto-language', { lang: lang ?? '' }))?.ok === true
}

export async function setTrustTailnet(connection: Connection, on: boolean): Promise<boolean> {
  return (await post(connection, '/api/tailnet/trust', { on }))?.ok === true
}

// Another of the person's PCs with a bridge, as a bridge found it on the tailnet.
export type FoundBridge = { name: string; baseUrl: string; pcId: string; trustTailnet: boolean }

export async function fetchTailnetBridges(connection: Connection): Promise<FoundBridge[]> {
  try {
    const res = await fetch(`${connection.baseUrl}/api/tailnet/bridges`, { headers: authHeaders(connection) })
    const body: { bridges?: Array<{ name?: unknown; baseUrl?: unknown; pcId?: unknown; trustTailnet?: unknown }> } = await res.json()
    const found: FoundBridge[] = []

    for (const item of Array.isArray(body.bridges) ? body.bridges : []) {
      if (typeof item.baseUrl !== 'string' || typeof item.pcId !== 'string') continue
      found.push({ name: typeof item.name === 'string' ? item.name : item.baseUrl, baseUrl: item.baseUrl, pcId: item.pcId, trustTailnet: item.trustTailnet === true })
    }

    return found
  } catch {
    return []
  }
}

// Asks a bridge that trusts its tailnet for a code of this device's own. It
// answers only over Tailscale and only to the same account's devices.
export async function claimTailnet(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tailnet/claim`, { method: 'POST', signal: AbortSignal.timeout(4000) })
    const body: { token?: unknown } = await res.json()

    return res.ok && typeof body.token === 'string' ? body.token : null
  } catch {
    return null
  }
}

// What a terminal on the PC runs: its shell, or a coding agent started in it.
export type TermRun = 'shell' | 'claude' | 'codex'

export type TermInfo = { id: string; title: string; cwd: string; run: TermRun; startedAt: number; exitCode: number | null; exited: boolean }

// `allowed`: whether this device may use the PC's terminals (its own app
// always; others once the PC's danger zone allows). `remote`: that setting.
export type TermState = { available: boolean; allowed: boolean; remote: boolean; terminals: TermInfo[] }

type TermBody = { id?: string; title?: string; cwd?: string; run?: string; startedAt?: number; exitCode?: number | null; exited?: boolean }

function termOf(body: TermBody | undefined): TermInfo | null {
  if (body === undefined || typeof body.id !== 'string' || typeof body.cwd !== 'string') return null

  const run: TermRun = body.run === 'claude' || body.run === 'codex' ? body.run : 'shell'

  return { id: body.id, title: body.title ?? '', cwd: body.cwd, run, startedAt: body.startedAt ?? 0, exitCode: body.exitCode ?? null, exited: body.exited === true }
}

export async function fetchTerms(connection: Connection): Promise<TermState | null> {
  const res = await fetch(`${connection.baseUrl}/api/term`, { headers: authHeaders(connection) }).catch(() => null)
  const body: { available?: boolean; allowed?: boolean; remote?: boolean; terminals?: TermBody[] } | null = res?.ok === true ? await res.json().catch(() => null) : null

  if (body === null) return null

  return {
    available: body.available === true,
    allowed: body.allowed === true,
    remote: body.remote === true,
    terminals: (body.terminals ?? []).flatMap(item => {
      const term = termOf(item)

      return term === null ? [] : [term]
    }),
  }
}

// A new terminal on the PC; the reason as text when it could not open.
export async function openTerm(connection: Connection, input: { cwd: string; run: TermRun; cols: number; rows: number; title: string; prompt: string }): Promise<TermInfo | string> {
  const res = await post(connection, '/api/term/open', input)
  const body: { terminal?: TermBody; error?: string } | null = res === null ? null : await res.json().catch(() => null)

  return termOf(body?.terminal) ?? body?.error ?? 'unreachable'
}

export async function termInput(connection: Connection, id: string, data: string): Promise<boolean> {
  return (await post(connection, '/api/term/input', { id, data }))?.ok === true
}

export async function termResize(connection: Connection, id: string, cols: number, rows: number): Promise<boolean> {
  return (await post(connection, '/api/term/resize', { id, cols, rows }))?.ok === true
}

export async function termClose(connection: Connection, id: string): Promise<boolean> {
  return (await post(connection, '/api/term/close', { id }))?.ok === true
}

export async function setRemoteTerminal(connection: Connection, on: boolean): Promise<boolean> {
  return (await post(connection, '/api/term/remote', { on }))?.ok === true
}

// The terminal's output as server-sent events (EventSource takes no headers).
export function termStreamUrl(connection: Connection, id: string): string {
  return `${connection.baseUrl}/api/term/stream?id=${encodeURIComponent(id)}&token=${encodeURIComponent(connection.token)}`
}
