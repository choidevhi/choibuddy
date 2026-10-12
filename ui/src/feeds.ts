import { useEffect, useMemo, useRef, useState } from 'react'
import { type Alert, type BrowserRequest, type Limits, type LiveStream, type Pending, PROTOCOL_VERSION, type Session, type Snapshot } from '../../shared/protocol.ts'
import type { LinkState } from './live.ts'
import { invoke } from '@tauri-apps/api/core'
import { type Connection, loadConnection, parseConnection, platform, writePref } from './platform.ts'

// One bridge the app listens to: this PC's own, or another PC paired in.
export type Source = {
  key: string
  connection: Connection
  local: boolean
}

export type Feed = Source & {
  snapshot: Snapshot | null
  link: LinkState
  // What each session is writing right now, by session id.
  streams: ReadonlyMap<string, LiveStream>
}

// A session or request together with the PC it lives on.
export type PcSession = Session & { uid: string; pcKey: string; pcName: string }

export type PcPending = Pending & { uid: string; pcKey: string; pcName: string }

const REMOTES_KEY = 'remotes'

function sourceOf(connection: Connection, local: boolean): Source {
  return { key: connection.baseUrl, connection, local }
}

// A JSON list of { baseUrl, token } from the Android shell or local storage.
function parseConnections(text: string): Connection[] {
  try {
    const list: Array<{ baseUrl?: string; token?: string }> = JSON.parse(text)

    if (!Array.isArray(list)) return []

    return list.flatMap(item =>
      typeof item.baseUrl === 'string' && typeof item.token === 'string' ? [{ baseUrl: item.baseUrl.replace(/\/+$/, ''), token: item.token }] : [],
    )
  } catch {
    return []
  }
}

// Other PCs added in the Windows widget (pairing links pasted from them).
export function readRemotes(): Connection[] {
  try {
    return parseConnections(localStorage.getItem(`choibuddy.${REMOTES_KEY}`) ?? '[]')
  } catch {
    return []
  }
}

export function saveRemotes(list: Connection[]): void {
  writePref(REMOTES_KEY, JSON.stringify(list))
}

export async function loadSources(): Promise<Source[]> {
  switch (platform) {
    case 'android': {
      const native = window.ChoiBuddyNative
      const list = native?.getConfigs === undefined ? [] : parseConnections(native.getConfigs())
      const single = parseConnection(native?.getConfig() ?? 'null')

      return (list.length > 0 ? list : single === null ? [] : [single]).map(connection => sourceOf(connection, false))
    }
    case 'windows': {
      const local = parseConnection(await invoke<string>('connection'))
      const remotes = readRemotes().filter(remote => remote.baseUrl !== local?.baseUrl)

      return [...(local === null ? [] : [sourceOf(local, true)]), ...remotes.map(remote => sourceOf(remote, false))]
    }
    case 'web': {
      const single = await loadConnection()

      return single === null ? [] : [sourceOf(single, false)]
    }
  }
}

function parseSnapshot(text: string): Snapshot | null {
  try {
    // The bridges speak the shared protocol; the version check catches a
    // bridge from another build.
    const value: Snapshot = JSON.parse(text)

    return value.protocol === PROTOCOL_VERSION && Array.isArray(value.sessions) && Array.isArray(value.pending) ? value : null
  } catch {
    return null
  }
}

function parseStream(text: string): LiveStream | null {
  try {
    const value: LiveStream = JSON.parse(text)

    return typeof value.sessionId === 'string' && typeof value.text === 'string' && typeof value.skippedLines === 'number' ? value : null
  } catch {
    return null
  }
}

function parseAlert(text: string): Alert | null {
  try {
    const value: Alert = JSON.parse(text)

    return typeof value.type === 'string' && typeof value.sessionId === 'string' ? value : null
  } catch {
    return null
  }
}

const STALE_MS = 45_000
const RETRY_MS = 3_000

type FeedState = { snapshot: Snapshot | null; link: LinkState; streams: ReadonlyMap<string, LiveStream> }

const EMPTY: FeedState = { snapshot: null, link: 'connecting', streams: new Map() }

// Keeps one live stream per source; the list is rebuilt whenever the
// sources change (a PC added or removed, a code replaced).
export type BrowserRequestFn = (request: BrowserRequest, source: Source) => void

function parseBrowserRequest(text: string): BrowserRequest | null {
  try {
    const value: BrowserRequest = JSON.parse(text)

    return typeof value.id === 'string' && typeof value.sessionId === 'string' ? value : null
  } catch {
    return null
  }
}

export function useFeeds(sources: Source[], onAlert: (alert: Alert, source: Source) => void, onBrowserRequest: BrowserRequestFn | null = null): Feed[] {
  const [states, setStates] = useState<ReadonlyMap<string, FeedState>>(new Map())
  const alertRef = useRef(onAlert)
  const browserRef = useRef(onBrowserRequest)
  const identity = sources.map(source => `${source.key}#${source.connection.token}`).join('|')

  alertRef.current = onAlert
  browserRef.current = onBrowserRequest

  useEffect(() => {
    const cleanups = sources.map(source => {
      let stream: EventSource | null = null
      let lastSeen = Date.now()
      let retry: number | null = null
      let closed = false
      const set = (patch: Partial<FeedState>): void =>
        setStates(current => new Map(current).set(source.key, { ...(current.get(source.key) ?? EMPTY), ...patch }))
      const { baseUrl, token } = source.connection

      const open = (): void => {
        if (closed) return

        stream?.close()
        lastSeen = Date.now()
        stream = new EventSource(`${baseUrl}/api/events?token=${encodeURIComponent(token)}`)
        stream.addEventListener('open', () => {
          lastSeen = Date.now()
          set({ link: 'live' })
        })
        stream.addEventListener('snapshot', event => {
          lastSeen = Date.now()

          const next = parseSnapshot(event.data)

          if (next !== null) set({ snapshot: next, link: 'live' })
        })
        stream.addEventListener('stream', event => {
          lastSeen = Date.now()

          const live = parseStream(event.data)

          if (live === null) return
          setStates(current => {
            const state = current.get(source.key) ?? EMPTY

            return new Map(current).set(source.key, { ...state, streams: new Map(state.streams).set(live.sessionId, live) })
          })
        })
        stream.addEventListener('alert', event => {
          lastSeen = Date.now()

          const alert = parseAlert(event.data)

          if (alert !== null) alertRef.current(alert, source)
        })
        // Any PC's bridge may ask: the browser open here can show Claude a
        // page for a session on another PC.
        stream.addEventListener('browser-request', event => {
          lastSeen = Date.now()

          const request = parseBrowserRequest(event.data)

          if (request !== null) browserRef.current?.(request, source)
        })
        stream.addEventListener('error', () => {
          if (stream?.readyState !== EventSource.CLOSED) {
            set({ link: 'offline' })
            return
          }

          // EventSource gives up on HTTP errors; ask the bridge why.
          void fetch(`${baseUrl}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` } })
            .then(res => set({ link: res.status === 401 ? 'unauthorized' : 'offline' }))
            .catch(() => set({ link: 'offline' }))
          retry ??= window.setTimeout(() => {
            retry = null
            open()
          }, RETRY_MS)
        })
      }

      // Heartbeats arrive every 15 s; a silent stream is a dead one.
      const watchdog = window.setInterval(() => {
        if (Date.now() - lastSeen > STALE_MS) {
          set({ link: 'offline' })
          open()
        }
      }, 5_000)

      set({ link: 'connecting' })
      open()

      return () => {
        closed = true
        window.clearInterval(watchdog)
        if (retry !== null) window.clearTimeout(retry)
        stream?.close()
      }
    })

    return () => {
      for (const cleanup of cleanups) cleanup()
    }
    // `identity` captures everything about `sources` that matters.
  }, [identity])

  return useMemo(
    () => sources.map(source => ({ ...source, ...(states.get(source.key) ?? EMPTY) })),
    [identity, states],
  )
}

export type Merged = {
  streams: ReadonlyMap<string, LiveStream>
  sessions: PcSession[]
  pending: PcPending[]
  limits: ReadonlyMap<string, Limits | null>
  galleryLatest: number
  multiPc: boolean
}

// One view over every PC. A PC reachable through two addresses (same pcId)
// is shown once.
export function merge(feeds: Feed[]): Merged {
  const seen = new Set<string>()
  const sessions: PcSession[] = []
  const pending: PcPending[] = []
  const limits = new Map<string, Limits | null>()
  const streams = new Map<string, LiveStream>()
  let galleryLatest = 0
  let pcs = 0

  for (const feed of feeds) {
    const snapshot = feed.snapshot

    if (snapshot === null || seen.has(snapshot.server.pcId)) continue

    seen.add(snapshot.server.pcId)
    pcs += 1

    const pcName = snapshot.server.hostName

    for (const session of snapshot.sessions) sessions.push({ ...session, uid: `${feed.key}|${session.id}`, pcKey: feed.key, pcName })
    for (const item of snapshot.pending) pending.push({ ...item, uid: `${feed.key}|${item.id}`, pcKey: feed.key, pcName })
    limits.set(feed.key, snapshot.limits)
    for (const [sessionId, live] of feed.streams) streams.set(sessionId, live)
    galleryLatest = Math.max(galleryLatest, snapshot.gallery.latestAt)
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  pending.sort((a, b) => a.createdAt - b.createdAt)

  return { streams, sessions, pending, limits, galleryLatest, multiPc: pcs > 1 }
}

export function feedFor(feeds: Feed[], pcKey: string | undefined): Feed | null {
  return feeds.find(feed => feed.key === pcKey) ?? null
}

