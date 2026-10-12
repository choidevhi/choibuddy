import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { type Alert, type BrowserRequest, type CommandInfo, type Decision, type DecisionBehavior, DEFAULT_PORT, type HistoryEntry, type LiveStream, type Project, PROMPT_MODES, type PromptMode, type ServerInfo } from '../../shared/protocol.ts'
import { type Config, type Device, hashToken, newToken, VERSION } from './config.ts'
import { arr, asObject, bool, type JsonObject, num, obj, objects, parseJsonObject, str, strings } from './json.ts'
import { Docs } from './docs.ts'
import { Gallery } from './gallery.ts'
import { claimLaunchPrompt, isFolder, type LaunchPrompt, openSession, openTerminal } from './launch.ts'
import { SessionMeta } from './meta.ts'
import { liveField, partialField, streamTail } from './partial.ts'
import { glanceAt, lastCwd, Transcripts } from './transcripts.ts'
import { baseName, type FileReader, languageOf } from './previews.ts'
import { parseHookInput, parseSlash, type Revival, Store } from './store.ts'
import { ownDevice, plainIp, readStatus, Tailnet } from './tailnet.ts'
import { purgeTrash } from './trash.ts'

const HOOK_BODY_LIMIT = 32 * 1024 * 1024
const UPLOAD_LIMIT = 50 * 1024 * 1024
const API_BODY_LIMIT = 256 * 1024
// Just under the 600 s timeout the installer gives the PermissionRequest
// hook, so the bridge answers "no decision" before Claude Code gives up.
const HOLD_MS = 590_000
const SNAPSHOT_THROTTLE_MS = 120
const HEARTBEAT_MS = 15_000
const PRUNE_MS = 60_000
const TAILNET_CHECK_MS = 30_000
const PREVIEW_FILE_LIMIT = 1_000_000
const HISTORY_LIMIT = 60
const HISTORY_AGE_MS = 30 * 24 * 60 * 60_000
const CONVERSATION_PAGE = 150
// A pairing code nobody used within this time stops working.
const PAIRING_TTL_MS = 30 * 60_000
const LAST_SEEN_SAVE_MS = 60_000
// How long Claude's browser_view call waits for the widget to answer.
const BROWSER_WAIT_MS = 15_000
const PROJECT_LIMIT = 30
const PROJECT_AGE_MS = 60 * 24 * 60 * 60_000
// One code per device and address at a time, however often it asks.
const CLAIM_GAP_MS = 5_000
const DISCOVER_CACHE_MS = 60_000
const PROBE_TIMEOUT_MS = 1_200
// Phones never run a bridge.
const PHONE_OS = new Set(['android', 'iOS'])

// What a ChoiBuddy bridge says about itself at /api/health.
export type BridgeHealth = { pcId: string; version: string; trustTailnet: boolean }

// Another of the person's PCs on the tailnet with a bridge on it.
export type FoundBridge = { name: string; baseUrl: string; pcId: string; version: string; trustTailnet: boolean }

function readCommands(path: string): CommandInfo[] {
  try {
    const stored = parseJsonObject(readFileSync(path, 'utf8'))

    return objects(arr(stored, 'commands')).flatMap((item): CommandInfo[] => {
      const name = str(item, 'name')

      return name === null ? [] : [{ name, description: str(item, 'description') ?? '', source: str(item, 'source') ?? '' }]
    })
  } catch {
    return []
  }
}

function saveCommands(path: string, commands: CommandInfo[]): void {
  try {
    writeFileSync(path, `${JSON.stringify({ commands })}\n`)
  } catch {
    // Kept for the next restart only; the live list is in memory.
  }
}

async function probeBridge(baseUrl: string): Promise<BridgeHealth | null> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const body = parseJsonObject(await res.text())

    if (str(body, 'name') !== 'choibuddy') return null

    return { pcId: str(body, 'pcId') ?? '', version: str(body, 'version') ?? '', trustTailnet: bool(body, 'trustTailnet') ?? false }
  } catch {
    return null
  }
}

// "Linux; Android 16; SM-S938N Build/..." → "SM-S938N"; a WebView2 window → "Windows".
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const android = /Android [\d.]+; ([^;)]+?)(?: Build\/|\))/.exec(ua)

  if (android?.[1] !== undefined) return android[1].trim()
  if (/Windows/.test(ua)) return 'Windows'
  if (/iPhone|iPad/.test(ua)) return 'iOS'
  if (/Macintosh/.test(ua)) return 'Mac'

  return 'Device'
}

export type BridgeOptions = {
  config: Config
  saveConfig: (config: Config) => void
  galleryDir: string
  uploadsDir: string
  docBackupDir: string
  // Deleted conversations; defaults to "trash" beside the uploads folder.
  trashDir?: string
  // Claude Code's own folder (~/.claude): transcripts, settings, mods.
  claudeDir: string
  log: (line: string) => void
  read?: FileReader
  now?: () => number
  holdMs?: number
  bindTailnet?: boolean
  // The last command list, kept across restarts; defaults to commands.json beside the uploads folder.
  commandsPath?: string
  // Names and archive flags; defaults to sessions.json beside the uploads folder.
  metaPath?: string
  // Who is on the tailnet (tests hand in a made-up one).
  tailscale?: Tailnet
  // Asks an address whether a bridge answers there.
  probe?: (baseUrl: string) => Promise<BridgeHealth | null>
}

export type Bridge = {
  store: Store
  port: number
  close: () => Promise<void>
}

type Held = {
  res: ServerResponse
  timer: NodeJS.Timeout
}

// Keeps letters, digits and a few marks; the rest of a name becomes "_".
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 120)

  return cleaned === '' ? 'file' : cleaned
}

function readBytes(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) tooBig = true
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

export function readPreviewFile(path: string): string | null {
  try {
    if (path === '' || statSync(path).size > PREVIEW_FILE_LIMIT) return null

    const buffer = readFileSync(path)

    if (buffer.subarray(0, 8000).includes(0)) return null

    return buffer.toString('utf8')
  } catch {
    return null
  }
}

export function tailnetAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family !== 'IPv4') continue

      const [first, second] = address.address.split('.').map(Number)

      // Tailscale hands out addresses from 100.64.0.0/10.
      if (first === 100 && second !== undefined && second >= 64 && second <= 127) return address.address
    }
  }

  return null
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) tooBig = true
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
}

function sendJson(res: ServerResponse, status: number, body: JsonObject): void {
  if (res.writableEnded) return

  const text = JSON.stringify(body)

  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

function tokenMatches(expected: string, given: string | null): boolean {
  if (given === null) return false

  const a = Buffer.from(expected)
  const b = Buffer.from(given)

  return a.length === b.length && timingSafeEqual(a, b)
}

const BEHAVIORS: ReadonlySet<string> = new Set<DecisionBehavior>(['allow', 'deny', 'always'])

function isBehavior(value: string): value is DecisionBehavior {
  return BEHAVIORS.has(value)
}

export function parseDecision(body: JsonObject): Decision | null {
  const id = str(body, 'id')
  const behavior = str(body, 'behavior')

  if (id === null || behavior === null || !isBehavior(behavior)) return null

  const rawAnswers = obj(body, 'answers')
  let answers: Record<string, string> | null = null

  if (rawAnswers !== null) {
    answers = {}
    for (const [question, answer] of Object.entries(rawAnswers)) {
      if (typeof answer === 'string') answers[question] = answer
    }
  }

  return { id, behavior, message: str(body, 'message'), answers }
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const { config, log } = options
  const now = options.now ?? Date.now
  const holdMs = options.holdMs ?? HOLD_MS
  const gallery = new Gallery(options.galleryDir, now, randomUUID)
  const store = new Store({ read: options.read ?? readPreviewFile, now, newId: randomUUID, gallery })
  const transcripts = new Transcripts(join(options.claudeDir, 'projects'))
  const meta = new SessionMeta(options.metaPath ?? join(options.uploadsDir, '..', 'sessions.json'))
  const tailscale = options.tailscale ?? new Tailnet(readStatus, now)
  const probe = options.probe ?? probeBridge
  // When each tailnet address last asked for a code.
  const claims = new Map<string, number>()
  let found: { at: number; list: FoundBridge[] } | null = null

  for (const [sessionId, name] of meta.names) store.setName(sessionId, name)

  const commandsPath = options.commandsPath ?? join(options.uploadsDir, '..', 'commands.json')

  store.seedCommands(readCommands(commandsPath))

  // Where a session the bridge lost left off, read from its transcript.
  const revival = (sessionId: string): Revival | null => {
    const path = transcripts.find(sessionId, null)

    if (path === null) return null

    let at = now()

    try {
      at = statSync(path).mtimeMs
    } catch {
      // Gone between finding and reading: it did something just now.
    }

    return { cwd: lastCwd(path) ?? glanceAt(path).cwd ?? '', transcript: path, at }
  }
  const docs = new Docs(options.claudeDir, options.docBackupDir)
  const trashDir = options.trashDir ?? join(options.uploadsDir, '..', 'trash')
  // In memory only: a restarted bridge always starts with this off.
  let autoAcceptUntil = 0
  // First prompts for sessions opened from a device, waiting for them to start.
  const launchPrompts: LaunchPrompt[] = []
  // Claude's browser_view calls waiting for the widget's answer.
  const browserWaits = new Map<string, Held>()

  purgeTrash(trashDir, now())
  const held = new Map<string, Held>()
  // Each live stream and which device opened it (null: this PC's own code).
  const clients = new Map<ServerResponse, string | null>()
  let lastSeenSave = 0
  let snapshotTimer: NodeJS.Timeout | null = null
  let tailnet: { ip: string; server: Server } | null = null

  const serverInfo = (): ServerInfo => ({
    pcId: config.pcId,
    // CHOIBUDDY_HOSTNAME stands in for the PC's name (demos, screenshots).
    hostName: process.env.CHOIBUDDY_HOSTNAME ?? hostname(),
    tailnetUrl: tailnet === null ? null : `http://${tailnet.ip}:${config.port}`,
    version: VERSION,
    autoAcceptUntil: autoAcceptUntil > now() ? autoAcceptUntil : 0,
    trustTailnet: config.trustTailnet,
  })

  // The person's other PCs with a bridge, found on the tailnet; this one left out.
  const discover = async (): Promise<FoundBridge[]> => {
    if (found !== null && now() - found.at < DISCOVER_CACHE_MS) return found.list

    const view = await tailscale.view()
    const ports = [...new Set([DEFAULT_PORT, config.port])]
    const candidates = view.peers.flatMap(peer =>
      peer.mine && peer.online && !PHONE_OS.has(peer.os) ? ports.map(port => ({ name: peer.name, baseUrl: `http://${peer.ip}:${port}` })) : [],
    )
    const answers = await Promise.all(candidates.map(async candidate => ({ candidate, health: await probe(candidate.baseUrl) })))
    const list: FoundBridge[] = []

    for (const { candidate, health } of answers) {
      if (health === null || health.pcId === '' || health.pcId === config.pcId || list.some(item => item.pcId === health.pcId)) continue
      list.push({ ...candidate, ...health })
    }

    found = { at: now(), list }

    return list
  }

  // One of the person's own Tailscale devices asks for a code of its own.
  // Only over the tailnet, only while this PC trusts its tailnet, and only
  // when Tailscale says the address is a device of the same account.
  const handleClaim = async (req: IncomingMessage, res: ServerResponse, loopbackListener: boolean): Promise<void> => {
    const ip = plainIp(req.socket.remoteAddress)

    if (req.method !== 'POST' || loopbackListener) {
      sendJson(res, 403, { ok: false, error: 'tailnet only' })

      return
    }

    if (!config.trustTailnet) {
      sendJson(res, 403, { ok: false, error: 'off' })

      return
    }

    if (now() - (claims.get(ip) ?? 0) < CLAIM_GAP_MS) {
      sendJson(res, 429, { ok: false, error: 'too soon' })

      return
    }

    claims.set(ip, now())

    const owner = ownDevice(await tailscale.view(), ip)

    if (owner === null) {
      log(`tailnet claim refused for ${ip}: not one of this account's devices`)
      sendJson(res, 403, { ok: false, error: 'not yours' })

      return
    }

    const token = newToken()
    const replaced = config.devices.filter(device => device.tailnet === ip)
    const name = owner === 'self' ? serverInfo().hostName : owner

    config.devices = [
      ...config.devices.filter(device => device.tailnet !== ip),
      { id: randomUUID().slice(0, 8), name, hash: hashToken(token), createdAt: now(), lastSeen: null, tailnet: ip },
    ]
    for (const device of replaced) dropDevice(device.id)
    options.saveConfig(config)
    log(`tailnet device ${name} (${ip}) connected by itself`)
    sendJson(res, 200, { ok: true, token, pcId: config.pcId, hostName: serverInfo().hostName })
  }

  const sendEvent = (event: string, data: string): void => {
    for (const client of clients.keys()) client.write(`event: ${event}\ndata: ${data}\n\n`)
  }

  const flushSnapshot = (): void => {
    snapshotTimer = null
    sendEvent('snapshot', JSON.stringify(store.snapshot(serverInfo())))
  }

  const scheduleSnapshot = (): void => {
    snapshotTimer ??= setTimeout(flushSnapshot, SNAPSHOT_THROTTLE_MS)
  }

  const emit = (alert: Alert): void => {
    sendEvent('alert', JSON.stringify(alert))
  }

  // Answers a held PermissionRequest hook. An empty answer means "no
  // decision": Claude Code keeps its own dialog open in the terminal.
  const finish = (id: string, output: JsonObject): void => {
    const entry = held.get(id)

    if (entry === undefined) return

    held.delete(id)
    clearTimeout(entry.timer)
    sendJson(entry.res, 200, output)

    const alert = store.resolvePending(id)

    if (alert !== null) emit(alert)
    scheduleSnapshot()
  }

  const handleHook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req, HOOK_BODY_LIMIT)
    const raw = body === null ? null : parseJsonObject(body)
    const input = raw === null ? null : parseHookInput(raw)

    if (input === null) {
      sendJson(res, 200, {})

      return
    }

    if (input.event === 'PermissionRequest') {
      const { pending, alert } = store.addPending(input)

      // Auto Accept answers plain permission requests at once; a question or
      // a plan still needs the person.
      if (autoAcceptUntil > now() && pending.kind === 'permission') {
        const output = store.decisionOutput(pending.id, { id: pending.id, behavior: 'allow', message: null, answers: null })

        store.resolvePending(pending.id)
        sendJson(res, 200, output ?? {})
        emit({ ...alert, type: 'auto' })
        scheduleSnapshot()
        log(`auto-accepted ${pending.tool} (${pending.sessionName})`)

        return
      }

      const timer = setTimeout(() => finish(pending.id, {}), holdMs)

      held.set(pending.id, { res, timer })
      res.on('close', () => {
        const entry = held.get(pending.id)

        if (entry === undefined) return

        // Claude Code dropped the request (interrupt or its own timeout).
        held.delete(pending.id)
        clearTimeout(entry.timer)

        const resolved = store.resolvePending(pending.id)

        if (resolved !== null) emit(resolved)
        scheduleSnapshot()
      })
      emit(alert)
      scheduleSnapshot()
      log(`pending ${pending.kind} ${pending.tool} (${pending.sessionName})`)

      return
    }

    const result = store.apply(input)

    sendJson(res, 200, {})
    for (const id of result.cleared) finish(id, {})
    for (const alert of result.alerts) emit(alert)
    scheduleSnapshot()
  }

  const handleDevices = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    if (req.method === 'GET' && url.pathname === '/api/devices') {
      const online = new Set(clients.values())

      sendJson(res, 200, {
        devices: liveDevices().map(device => ({
          id: device.id,
          name: device.name,
          createdAt: device.createdAt,
          lastSeen: device.lastSeen,
          online: online.has(device.id),
        })),
      })

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/devices') {
      const token = newToken()
      const device: Device = { id: randomUUID().slice(0, 8), name: '', hash: hashToken(token), createdAt: now(), lastSeen: null, tailnet: null }

      config.devices = [...liveDevices(), device]
      options.saveConfig(config)
      log(`pairing code created ${device.id}`)
      // The code itself is shown once, in the QR, and never stored.
      sendJson(res, 200, { id: device.id, token })

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/devices/revoke') {
      const body = await readBody(req, API_BODY_LIMIT)
      const id = str(body === null ? null : parseJsonObject(body), 'id')
      const known = config.devices.some(device => device.id === id)

      if (id === null || !known) {
        sendJson(res, 404, { ok: false })

        return
      }

      config.devices = config.devices.filter(device => device.id !== id)
      options.saveConfig(config)
      dropDevice(id)
      log(`device revoked ${id}`)
      sendJson(res, 200, { ok: true })

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/rotate' && isLoopback(req.socket.remoteAddress)) {
      // Every device and this PC's own code are replaced; every stream closes.
      config.token = newToken()
      config.devices = []
      options.saveConfig(config)
      for (const client of clients.keys()) client.end()
      clients.clear()
      log('all codes rotated')
      sendJson(res, 200, { ok: true })

      return
    }

    sendJson(res, 404, { ok: false })
  }

  const handleMod = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const body = await readBody(req, API_BODY_LIMIT)
    const parsed = body === null ? null : parseJsonObject(body)

    if (parsed === null) {
      sendJson(res, 400, { ok: false })

      return
    }

    if (path === '/mod/usage') {
      if (store.applyUsage(parsed)) scheduleSnapshot()
      sendJson(res, 200, { ok: true })

      return
    }

    if (path === '/mod/stream') {
      const sessionId = str(parsed, 'sessionId')
      const tool = str(parsed, 'tool')
      const field = tool === null ? null : liveField(tool)
      const json = str(parsed, 'json') ?? ''
      const filePath = partialField(json, 'file_path') ?? partialField(json, 'notebook_path')
      const text = field === null ? str(parsed, 'text') : partialField(json, field)

      if (sessionId !== null && text !== null) {
        const tail = streamTail(text)
        const stream: LiveStream = {
          sessionId,
          toolUseId: str(parsed, 'toolUseId'),
          tool,
          path: filePath,
          language: filePath === null ? 'plain' : languageOf(filePath),
          skippedLines: tail.skippedLines,
          text: tail.text,
          at: now(),
        }

        sendEvent('stream', JSON.stringify(stream))
      }
      sendJson(res, 200, { ok: true })

      return
    }

    if (path === '/mod/poll') {
      const sessionId = str(parsed, 'sessionId')

      // Claude Code is open for this session even when the bridge lost it.
      if (sessionId !== null && store.revive(sessionId, () => revival(sessionId))) {
        log(`session ${sessionId} is back: its mod still polls`)
        scheduleSnapshot()
      }

      const prompts = sessionId === null ? [] : store.takePrompts(sessionId)
      const commands = sessionId === null ? [] : store.takeCommands(sessionId)
      const session = sessionId === null ? undefined : store.sessions.get(sessionId)
      const first = session === undefined ? null : claimLaunchPrompt(launchPrompts, session.cwd, session.startedAt, now())

      // A session opened from a device gets the prompt typed with it.
      if (first !== null && sessionId !== null) {
        store.queuePrompt(sessionId, first)
        scheduleSnapshot()
      }

      if (prompts.length > 0 || commands.length > 0) {
        log(`delivering ${prompts.length} prompt(s), ${commands.length} command(s) to ${sessionId}`)
        scheduleSnapshot()
      }
      // A bridge that restarted lost the session's commands: the mod sends them again.
      sendJson(res, 200, { ok: true, prompts, commands, needCommands: sessionId !== null && !store.knowsCommands(sessionId) })

      return
    }

    if (path === '/mod/steered') {
      const sessionId = str(parsed, 'sessionId') ?? ''

      if (store.steered(sessionId, strings(arr(parsed, 'ids')))) {
        log(`steered ${strings(arr(parsed, 'ids')).length} message(s) into ${sessionId}`)
        scheduleSnapshot()
      }
      sendJson(res, 200, { ok: true })

      return
    }

    if (path === '/mod/step') {
      if (store.applyStep(parsed)) scheduleSnapshot()
      sendJson(res, 200, { ok: true })

      return
    }

    if (path === '/mod/commands') {
      const sessionId = str(parsed, 'sessionId')
      const commands = objects(arr(parsed, 'commands')).flatMap((item): CommandInfo[] => {
        const name = str(item, 'name')

        return name === null ? [] : [{ name, description: str(item, 'description') ?? '', source: str(item, 'source') ?? '' }]
      })

      if (sessionId !== null) store.setCommands(sessionId, commands)
      if (commands.length > 0) saveCommands(commandsPath, commands)
      sendJson(res, 200, { ok: true })

      return
    }

    if (path === '/mod/command-result') {
      if (store.commandResult(parsed)) {
        log(`command /${str(parsed, 'command') ?? ''} ran in ${str(parsed, 'sessionId') ?? ''}${bool(parsed, 'failed') === true ? ' (failed)' : ''}`)
        scheduleSnapshot()
      }
      sendJson(res, 200, { ok: true })

      return
    }

    if (path === '/mod/browser-view') {
      const request: BrowserRequest = { id: randomUUID(), sessionId: str(parsed, 'sessionId') ?? '' }
      const timer = setTimeout(() => {
        browserWaits.delete(request.id)
        sendJson(res, 200, { ok: false, error: 'The ChoiBuddy browser on this PC did not answer. Ask the person to open the Browser tab in ChoiBuddy and load the page.' })
      }, BROWSER_WAIT_MS)

      browserWaits.set(request.id, { res, timer })
      sendEvent('browser-request', JSON.stringify(request))

      return
    }

    sendJson(res, 404, { ok: false })
  }

  const liveDevices = (): Device[] => {
    const cutoff = now() - PAIRING_TTL_MS
    const kept = config.devices.filter(device => device.lastSeen !== null || device.createdAt > cutoff)

    if (kept.length !== config.devices.length) {
      config.devices = kept
      options.saveConfig(config)
    }

    return kept
  }

  // Who is calling: this PC's own code (can manage devices) or a paired device.
  const authenticate = (req: IncomingMessage, given: string | null): { device: Device | null } | null => {
    if (given === null) return null
    if (tokenMatches(config.token, given)) return { device: null }

    const hash = hashToken(given)
    const device = liveDevices().find(item => tokenMatches(item.hash, hash))

    if (device === undefined) return null

    const firstUse = device.lastSeen === null

    device.lastSeen = now()
    if (firstUse && device.name === '') device.name = deviceName(req.headers['user-agent'])
    if (firstUse || now() - lastSeenSave > LAST_SEEN_SAVE_MS) {
      lastSeenSave = now()
      options.saveConfig(config)
    }

    return { device }
  }

  const dropDevice = (deviceId: string): void => {
    for (const [client, owner] of clients) {
      if (owner !== deviceId) continue
      client.end()
      clients.delete(client)
    }
  }

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const auth = req.headers.authorization
    const given = auth?.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token')
    const caller = authenticate(req, given)

    if (caller === null) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })

      return
    }

    if (url.pathname.startsWith('/api/devices') || url.pathname === '/api/rotate') {
      // Only this PC's own code manages who else may connect.
      if (caller.device !== null) {
        sendJson(res, 403, { ok: false, error: 'owner only' })

        return
      }

      await handleDevices(req, res, url)

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(store.snapshot(serverInfo()))}\n\n`)
      clients.set(res, caller.device?.id ?? null)
      req.on('close', () => clients.delete(res))

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      sendJson(res, 200, store.snapshot(serverInfo()))

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const body = await readBody(req, API_BODY_LIMIT)
      const parsed = body === null ? null : parseJsonObject(body)
      const decision = parsed === null ? null : parseDecision(parsed)

      if (decision === null) {
        sendJson(res, 400, { ok: false, error: 'bad decision' })

        return
      }

      const output = store.decisionOutput(decision.id, decision)

      if (output === null || !held.has(decision.id)) {
        sendJson(res, 404, { ok: false, error: 'not pending' })

        return
      }

      log(`decided ${decision.behavior} ${decision.id}`)
      finish(decision.id, output)
      sendJson(res, 200, { ok: true })

      return
    }

    // A file sent from the phone or the widget, saved on this PC so Claude
    // can open it; pictures also go to the gallery.
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const bytes = await readBytes(req, UPLOAD_LIMIT)

      if (bytes === null || bytes.length === 0) {
        sendJson(res, 413, { ok: false, error: 'too large or empty' })

        return
      }

      const name = safeFileName(url.searchParams.get('name') ?? 'file')
      const day = new Date(now()).toISOString().slice(0, 10)
      const dir = join(options.uploadsDir, day)
      const path = join(dir, `${randomUUID().slice(0, 8)}-${name}`)

      mkdirSync(dir, { recursive: true })
      writeFileSync(path, bytes)

      const sessionId = url.searchParams.get('session') ?? ''
      const session = store.sessions.get(sessionId)

      if (session !== undefined) gallery.addFile({ sessionId, sessionName: session.name, tool: 'upload' }, path)
      log(`upload ${bytes.length} bytes`)
      scheduleSnapshot()
      sendJson(res, 200, { ok: true, path, name, size: bytes.length })

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/setup') {
      if (caller.device !== null) {
        sendJson(res, 403, { ok: false })

        return
      }

      sendJson(res, 200, setupStatus(options.claudeDir))

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/auto-accept') {
      const body = await readBody(req, API_BODY_LIMIT)
      const minutes = num(body === null ? null : parseJsonObject(body), 'minutes') ?? Number.NaN

      if (!Number.isFinite(minutes)) {
        sendJson(res, 400, { ok: false })

        return
      }

      // 0 turns it off; a negative number keeps it on until turned off.
      autoAcceptUntil = minutes === 0 ? 0 : minutes < 0 ? Number.MAX_SAFE_INTEGER : now() + minutes * 60_000
      log(`auto-accept ${minutes === 0 ? 'off' : minutes < 0 ? 'on until off' : `on for ${minutes} min`}`)
      scheduleSnapshot()
      sendJson(res, 200, { ok: true, autoAcceptUntil })

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/docs') {
      const dirs = [...new Set([...[...store.sessions.values()].map(session => session.cwd), ...transcripts.recent(30, 30 * 24 * 60 * 60_000, now()).map(entry => entry.cwd)])]

      sendJson(res, 200, { groups: docs.list(dirs) })

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/docs/file') {
      const found = docs.read(url.searchParams.get('id') ?? '')

      sendJson(res, found === null ? 404 : 200, found === null ? { ok: false } : { ok: true, file: found.file, text: found.text })

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/docs/file') {
      const body = await readBody(req, API_BODY_LIMIT * 8)
      const parsed = body === null ? null : parseJsonObject(body)
      const result = docs.write(str(parsed, 'id') ?? '', str(parsed, 'text') ?? '', num(parsed, 'mtime') ?? 0)

      if (result.ok) log(`doc saved ${baseName(result.file.path)}`)
      sendJson(res, result.ok ? 200 : result.reason === 'conflict' ? 409 : 400, result)

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const live = [...store.sessions.values()].map((session): HistoryEntry => {
        const path = transcripts.find(session.id, store.transcriptPath(session.id))

        return {
          sessionId: session.id,
          project: session.name,
          cwd: session.cwd,
          title: meta.name(session.id) ?? (path === null ? '' : transcripts.reader(path).bestTitle),
          updatedAt: session.updatedAt,
          live: true,
          archived: false,
        }
      })
      const liveIds = new Set(live.map(entry => entry.sessionId))
      const past: HistoryEntry[] = []

      for (const entry of transcripts.recent(HISTORY_LIMIT, HISTORY_AGE_MS, now())) {
        if (liveIds.has(entry.sessionId)) continue
        past.push({ ...entry, title: meta.name(entry.sessionId) ?? entry.title, archived: meta.archived(entry.sessionId) })
      }

      sendJson(res, 200, { sessions: [...live.sort((a, b) => b.updatedAt - a.updatedAt), ...past] })

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/conversation') {
      const sessionId = url.searchParams.get('session') ?? ''
      const path = transcripts.find(sessionId, store.transcriptPath(sessionId))
      const before = Number(url.searchParams.get('before'))
      const limit = Number(url.searchParams.get('limit'))
      const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : Number.NaN

      if (path === null) {
        sendJson(res, 404, { ok: false })

        return
      }

      sendJson(
        res,
        200,
        transcripts.conversation(
          sessionId,
          path,
          Number.isFinite(before) && before > 0 ? before : null,
          Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : CONVERSATION_PAGE,
          Number.isFinite(from) && from >= 0 ? from : null,
        ),
      )

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/gallery') {
      sendJson(res, 200, { images: gallery.list() })

      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/image/')) {
      const file = gallery.file(decodeURIComponent(url.pathname.slice('/api/image/'.length)))

      if (file === null) {
        sendJson(res, 404, { ok: false })

        return
      }

      // An SVG Claude read could carry script; sandboxing keeps it a picture
      // even when the URL (which holds the token) is opened directly.
      res.writeHead(200, {
        'Content-Type': file.mime,
        'Content-Length': file.size,
        'Cache-Control': 'private, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      })
      createReadStream(file.path).on('error', () => res.destroy()).pipe(res)

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/prompt') {
      const body = await readBody(req, API_BODY_LIMIT)
      const parsed = body === null ? null : parseJsonObject(body)
      const sessionId = str(parsed, 'sessionId')
      const text = str(parsed, 'text')?.trim() ?? ''

      if (sessionId === null || text === '') {
        sendJson(res, 400, { ok: false, error: 'bad prompt' })

        return
      }

      // "/name args" for a command the session offers runs as that command;
      // anything else (also "/" followed by an unknown name) is a prompt.
      const slash = parseSlash(text)
      const known = slash !== null && store.commandsFor(sessionId).some(command => command.name === slash.command)
      const requested = str(parsed, 'mode') ?? ''
      const mode: PromptMode = PROMPT_MODES.find(item => item === requested) ?? 'steer'
      const result = slash !== null && known ? store.queueCommand(sessionId, slash.command, slash.args) : store.queuePrompt(sessionId, text, mode)

      log(`${known ? 'command' : 'prompt'} for ${sessionId}: ${result}`)
      scheduleSnapshot()
      sendJson(res, result === 'queued' ? 200 : 409, { ok: result === 'queued', result })

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/commands') {
      sendJson(res, 200, { ok: true, commands: store.commandsFor(url.searchParams.get('session') ?? '') })

      return
    }

    if (req.method === 'POST' && (url.pathname === '/api/gallery/delete' || url.pathname === '/api/gallery/clear')) {
      const body = await readBody(req, API_BODY_LIMIT)
      const id = str(body === null ? null : parseJsonObject(body), 'id')
      const removed = url.pathname === '/api/gallery/clear' ? gallery.clear() : Number(id !== null && gallery.remove(id))

      log(`gallery: ${removed} removed`)
      scheduleSnapshot()
      sendJson(res, 200, { ok: true, removed })

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/conversation/delete') {
      const body = await readBody(req, API_BODY_LIMIT)
      const sessionId = str(body === null ? null : parseJsonObject(body), 'sessionId') ?? ''
      const live = store.sessions.get(sessionId)

      // A session that is still open keeps writing to its transcript.
      if (live !== undefined && live.status !== 'ended') {
        sendJson(res, 409, { ok: false, error: 'live' })

        return
      }

      const moved = transcripts.trash(sessionId, trashDir, now())

      if (moved) {
        store.dismiss(sessionId)
        meta.forget(sessionId)
        log(`conversation ${sessionId} moved to trash`)
        scheduleSnapshot()
      }
      sendJson(res, moved ? 200 : 404, { ok: moved })

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/sessions/rename') {
      const body = await readBody(req, API_BODY_LIMIT)
      const parsed = body === null ? null : parseJsonObject(body)
      const sessionId = str(parsed, 'sessionId') ?? ''
      const title = str(parsed, 'title')

      if (sessionId === '' || title === null) {
        sendJson(res, 400, { ok: false })

        return
      }

      const name = meta.rename(sessionId, title)

      store.setName(sessionId, name)
      scheduleSnapshot()
      sendJson(res, 200, { ok: true, name })

      return
    }

    // Puts ended sessions away (or brings them back); open ones stay listed.
    if (req.method === 'POST' && url.pathname === '/api/sessions/archive') {
      const body = await readBody(req, API_BODY_LIMIT)
      const parsed = body === null ? null : parseJsonObject(body)
      const ended: string[] = []

      for (const sessionId of strings(arr(parsed, 'sessionIds'))) {
        const open = store.sessions.get(sessionId)

        if (open === undefined || open.status === 'ended') ended.push(sessionId)
      }

      sendJson(res, 200, { ok: true, changed: meta.setArchived(ended, bool(parsed, 'archived') ?? true) })

      return
    }

    // Asks Claude Code to close the session, the same as typing /exit there.
    if (req.method === 'POST' && url.pathname === '/api/sessions/end') {
      const body = await readBody(req, API_BODY_LIMIT)
      const sessionId = str(body === null ? null : parseJsonObject(body), 'sessionId') ?? ''
      const session = store.sessions.get(sessionId)

      if (session === undefined || session.status === 'ended') {
        sendJson(res, 404, { ok: false, error: 'not open' })

        return
      }

      const result = store.queueCommand(sessionId, 'exit', '')

      if (result !== 'queued') {
        sendJson(res, 409, { ok: false, error: result })

        return
      }

      log(`asked ${sessionId} to end`)
      scheduleSnapshot()
      sendJson(res, 200, { ok: true })

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/tailnet/bridges') {
      sendJson(res, 200, { bridges: await discover() })

      return
    }

    // Only this PC's own code decides whether its tailnet is trusted.
    if (req.method === 'POST' && url.pathname === '/api/tailnet/trust') {
      if (caller.device !== null) {
        sendJson(res, 403, { ok: false, error: 'owner only' })

        return
      }

      const body = await readBody(req, API_BODY_LIMIT)
      const on = bool(body === null ? null : parseJsonObject(body), 'on') ?? false

      config.trustTailnet = on

      // Turning it off cuts every device that came in through it.
      if (!on) {
        for (const device of config.devices) {
          if (device.tailnet !== null) dropDevice(device.id)
        }
        config.devices = config.devices.filter(device => device.tailnet === null)
      }

      options.saveConfig(config)
      log(`tailnet trust ${on ? 'on' : 'off'}`)
      scheduleSnapshot()
      sendJson(res, 200, { ok: true, trustTailnet: on })

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const seen = new Set<string>()
      const projects: Project[] = []
      const candidates = [
        ...[...store.sessions.values()].map(session => ({ cwd: session.cwd, lastUsed: session.updatedAt })),
        ...transcripts.recent(120, PROJECT_AGE_MS, now()).map(entry => ({ cwd: entry.cwd, lastUsed: entry.updatedAt })),
      ].sort((a, b) => b.lastUsed - a.lastUsed)

      for (const candidate of candidates) {
        const key = candidate.cwd.toLowerCase()

        if (candidate.cwd === '' || seen.has(key) || projects.length >= PROJECT_LIMIT) continue
        seen.add(key)
        if (isFolder(candidate.cwd)) projects.push({ cwd: candidate.cwd, name: baseName(candidate.cwd), lastUsed: candidate.lastUsed })
      }

      sendJson(res, 200, { ok: true, projects })

      return
    }

    // A terminal on this PC: in a session's folder, or the home folder.
    if (req.method === 'POST' && url.pathname === '/api/terminal/open') {
      const body = await readBody(req, API_BODY_LIMIT)
      const cwd = str(body === null ? null : parseJsonObject(body), 'cwd')?.trim() ?? ''
      const opened = openTerminal(cwd === '' ? homedir() : cwd)

      log(opened.ok ? `terminal in ${cwd === '' ? '~' : cwd} (${opened.terminal})` : `terminal failed: ${opened.error}`)
      sendJson(res, opened.ok ? 200 : 400, opened.ok ? { ok: true, terminal: opened.terminal } : { ok: false, error: opened.error })

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/session/new') {
      const body = await readBody(req, API_BODY_LIMIT)
      const parsed = body === null ? null : parseJsonObject(body)
      const cwd = str(parsed, 'cwd')?.trim() ?? ''
      const prompt = str(parsed, 'prompt')?.trim() ?? ''
      const opened = openSession(cwd)

      if (opened.ok && prompt !== '') launchPrompts.push({ cwd, text: prompt, at: now() })
      log(opened.ok ? `new session in ${cwd} (${opened.terminal})` : `new session failed: ${opened.error}`)
      sendJson(res, opened.ok ? 200 : 400, opened.ok ? { ok: true, terminal: opened.terminal } : { ok: false, error: opened.error })

      return
    }

    // A ChoiBuddy app with its browser open answers Claude's browser_view call:
    // this PC's, or another PC's that follows this session. A device that may
    // send prompts may show Claude a page too; the first answer counts.
    if (req.method === 'POST' && url.pathname === '/api/browser/answer') {
      const body = await readBody(req, UPLOAD_LIMIT)
      const parsed = body === null ? null : parseJsonObject(body)
      const wait = browserWaits.get(str(parsed, 'id') ?? '')

      if (parsed === null || wait === undefined) {
        sendJson(res, 404, { ok: false })

        return
      }

      browserWaits.delete(str(parsed, 'id') ?? '')
      clearTimeout(wait.timer)

      if (bool(parsed, 'ok') !== true) {
        sendJson(wait.res, 200, { ok: false, error: str(parsed, 'error') ?? 'The ChoiBuddy browser is not open.' })
        sendJson(res, 200, { ok: true })

        return
      }

      const image = str(parsed, 'image')
      let imagePath: string | null = null

      if (image !== null && image !== '') {
        mkdirSync(options.uploadsDir, { recursive: true })
        imagePath = join(options.uploadsDir, `browser-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.png`)
        writeFileSync(imagePath, Buffer.from(image, 'base64'))
      }

      sendJson(wait.res, 200, { ok: true, url: str(parsed, 'url') ?? '', title: str(parsed, 'title') ?? '', imagePath, picked: str(parsed, 'picked') })
      sendJson(res, 200, { ok: true })

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/dismiss') {
      const body = await readBody(req, API_BODY_LIMIT)
      const sessionId = str(body === null ? null : parseJsonObject(body), 'sessionId')
      const removed = sessionId !== null && store.dismiss(sessionId)

      scheduleSnapshot()
      sendJson(res, removed ? 200 : 404, { ok: removed })

      return
    }

    if (req.method === 'POST' && url.pathname === '/api/shutdown' && isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 200, { ok: true })
      setTimeout(() => process.exit(0), 50)

      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  const handler = (loopbackListener: boolean) => (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://bridge.local')

    cors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()

      return
    }

    const done = (error: Error): void => {
      log(`request failed ${url.pathname}: ${error.message}`)
      sendJson(res, 500, { ok: false })
    }

    if (url.pathname === '/hook' || url.pathname.startsWith('/mod/')) {
      // Only Claude Code on this PC (its hooks and the companion mod) may
      // feed events: never a browser page (it would send Origin) and never
      // the tailnet listener.
      const allowed = loopbackListener && isLoopback(req.socket.remoteAddress) && req.headers.origin === undefined

      if (!allowed || req.method !== 'POST') {
        sendJson(res, 403, { ok: false })

        return
      }

      const work = url.pathname === '/hook' ? handleHook(req, res) : handleMod(req, res, url.pathname)

      work.catch(done)

      return
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, name: 'choibuddy', version: VERSION, pid: process.pid, pcId: config.pcId, trustTailnet: config.trustTailnet })

      return
    }

    if (url.pathname === '/api/tailnet/claim') {
      handleClaim(req, res, loopbackListener).catch(done)

      return
    }

    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch(done)

      return
    }

    sendJson(res, 404, { ok: false })
  }

  const listen = (server: Server, host: string, port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)

        const address = server.address()

        resolve(typeof address === 'object' && address !== null ? address.port : port)
      })
    })

  const loopback = createServer(handler(true))
  const port = await listen(loopback, '127.0.0.1', config.port)

  const syncTailnet = async (): Promise<void> => {
    const ip = tailnetAddress()

    if (tailnet?.ip === ip) return

    if (tailnet !== null) {
      tailnet.server.close()
      tailnet = null
    }

    if (ip === null) return

    const server = createServer(handler(false))

    try {
      await listen(server, ip, port)
      tailnet = { ip, server }
      log(`tailnet listener on http://${ip}:${port}`)
      scheduleSnapshot()
    } catch (error) {
      log(`tailnet listen failed on ${ip}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const timers: NodeJS.Timeout[] = [
    setInterval(() => {
      for (const client of clients.keys()) client.write(': ping\n\n')
    }, HEARTBEAT_MS),
    setInterval(() => {
      if (store.prune().length > 0) scheduleSnapshot()
    }, PRUNE_MS),
  ]

  if (options.bindTailnet !== false) {
    await syncTailnet()
    timers.push(setInterval(() => void syncTailnet(), TAILNET_CHECK_MS))
  }

  log(`bridge ${VERSION} listening on 127.0.0.1:${port}`)

  const close = async (): Promise<void> => {
    for (const timer of timers) clearInterval(timer)
    if (snapshotTimer !== null) clearTimeout(snapshotTimer)
    for (const id of [...held.keys()]) finish(id, {})
    for (const wait of browserWaits.values()) {
      clearTimeout(wait.timer)
      sendJson(wait.res, 200, { ok: false, error: 'ChoiBuddy is shutting down.' })
    }
    browserWaits.clear()
    for (const client of clients.keys()) client.end()
    gallery.flush()
    tailnet?.server.close()
    await new Promise<void>(resolve => loopback.close(() => resolve()))
  }

  return { store, port, close }
}

// Whether Claude Code on this PC is wired to the bridge: hooks in its
// settings, and the companion mod (usage, prompts) installed and enabled.
export function setupStatus(claudeDir: string): JsonObject {
  let settings: JsonObject | null = null

  try {
    settings = parseJsonObject(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))
  } catch {
    settings = null
  }

  const hooksText = JSON.stringify(settings?.hooks ?? null)
  const plugins = asObject(settings?.enabledPlugins)

  return {
    hooks: hooksText.includes('X-ChoiBuddy'),
    mod: existsSync(join(claudeDir, 'local-mods', 'choibuddy', 'hooks', 'register.ts')) && plugins?.['choibuddy@local-mods'] === true,
  }
}
