import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Alert, type BrowserRequest, type CommandInfo, type Decision, type DecisionBehavior, DEFAULT_PORT, type HistoryEntry, type LiveStream, type Project, type PromptMode, type ServerInfo } from '../../shared/protocol.ts'
import { type Config, type Device, hashToken, newToken, VERSION } from './config.ts'
import { arr, asObject, bool, type Json, type JsonObject, num, obj, objects, parseJsonObject, str, strings } from './json.ts'
import { Docs } from './docs.ts'
import { Gallery, imageMime } from './gallery.ts'
import { CODEX_TOOLS, codexCommand, codexHooksCurrent, type CodexState, codexState, type CodexTools, type CodexTrust, codexTrust, fromCodex, setCodexHooks } from './codex.ts'
import { CODEX_COMMANDS, CodexChats, type KeptChat } from './codex-chat.ts'
import { CodexRollouts, emptyReading } from './codex-rollout.ts'
import { AutoLanguage, parseLang } from './language.ts'
import { type TermRun, Terminals } from './terminal.ts'
import { claimLaunchPrompt, isFolder, type LaunchPrompt, openSession, openTerminal } from './launch.ts'
import { SessionMeta } from './meta.ts'
import { type EngineMessage, LEGACY, LiveChats } from './live-chat.ts'
import { liveField, partialField, streamTail } from './partial.ts'
import { glanceAt, lastCwd, Transcripts, userText } from './transcripts.ts'
import { baseName, type FileReader, languageOf } from './previews.ts'
import { type HookInput, parseHookInput, parseSlash, RELOAD_COMMAND, type Revival, Store } from './store.ts'
import { ownDevice, plainIp, readStatus, Tailnet } from './tailnet.ts'
import { purgeTrash } from './trash.ts'

const HOOK_BODY_LIMIT = 32 * 1024 * 1024
const UPLOAD_LIMIT = 50 * 1024 * 1024
const API_BODY_LIMIT = 256 * 1024
// Terminal output a few milliseconds apart goes out as one event.
const TERM_FLUSH_MS = 12
// Just under the 600 s timeout the installer gives the PermissionRequest
// hook, so the bridge answers "no decision" before Claude Code gives up.
const HOLD_MS = 590_000
const SNAPSHOT_THROTTLE_MS = 120
const HEARTBEAT_MS = 15_000
// Codex sessions ChoiBuddy ran, kept for the next start of the bridge.
const KEPT_CHATS = 30
// Picture types Codex takes as images with a prompt.
const CODEX_IMAGES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
// A working Codex session's record is read this often (pictures, usage).
const CODEX_READ_MS = 2_000
// Open conversations' transcripts are read this often for what they gained.
const CHAT_TICK_MS = 250
// The most of Claude Code's own messages the mod sends, and of each one's text.
const ENGINE_TAIL = 40
const ENGINE_TEXT = 20_000
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
// How long Codex's answer on whether it trusts the hooks is kept.
const CODEX_CHECK_MS = 60_000
// An upload left in a prompt box this long is forgotten (the file stays).
const UPLOAD_WAIT_MS = 7 * 24 * 60 * 60_000
// How often the installed mod's version is read again.
const MOD_CHECK_MS = 30_000
// Claude Code's own commands that run as commands even before a session has
// listed its commands (an older mod never does after a bridge restart).
const ALWAYS_COMMANDS = new Set(['exit', 'reload-plugins'])
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

function readModVersion(path: string): string | null {
  try {
    return str(parseJsonObject(readFileSync(path, 'utf8')), 'version')
  } catch {
    return null
  }
}

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
  // The installed companion mod's manifest, for its version.
  modManifest?: string
  // Codex's settings folder (~/.codex), where its hooks.json lives. Left out,
  // the bridge leaves Codex alone (tests must never touch the real one).
  codexHome?: string
  // Codex's programs on the PC (to install the CLI and trust the hooks).
  codexTools?: CodexTools
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

// The Codex sessions kept by an earlier start of the bridge.
function readKeptChats(path: string): KeptChat[] {
  try {
    const parsed: Json = JSON.parse(readFileSync(path, 'utf8'))

    return (Array.isArray(parsed) ? objects(parsed) : []).flatMap(item => {
      const id = str(item, 'id')
      const cwd = str(item, 'cwd')

      return id === null || cwd === null ? [] : [{ id, cwd, path: str(item, 'path'), model: str(item, 'model'), effort: str(item, 'effort'), startedAt: num(item, 'startedAt') ?? 0 }]
    })
  } catch {
    return []
  }
}

type Held = {
  res: ServerResponse
  timer: NodeJS.Timeout
}

// An approval waiting for the person: answered with the hook's output, and
// the decision itself when there is one (none: it timed out or went away).
type HeldApproval = {
  answer: (output: JsonObject, decision: Decision | null) => void
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

  const codexHome = options.codexHome ?? null
  // What Codex runs: this bridge's own Node and hook script.
  const codexHook = codexCommand(process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'ensure.ts'))
  const codexTools = options.codexTools ?? CODEX_TOOLS
  const terminals = new Terminals(now, () => codexLaunch())
  // Screens following a terminal, with the paired device behind each (null:
  // this PC's own app). A device is cut off when its access goes away.
  const termStreams = new Map<ServerResponse, string | null>()
  const endTermStreams = (match: (device: string | null) => boolean): void => {
    for (const [stream, device] of termStreams) {
      if (!match(device)) continue
      stream.end()
      termStreams.delete(stream)
    }
  }
  // The Codex app's own codex.exe, looked up once (it takes a moment).
  // Kept also when there is none, or every check would ask PowerShell again.
  let codexAppFound: { program: string[] | null } | null = null
  let codexChecked: { at: number; trusted: boolean | null } | null = null
  let codexInstalling: Promise<boolean> | null = null

  const codexApp = (): string[] | null => {
    codexAppFound ??= { program: codexTools.app() }

    return codexAppFound.program
  }

  // How a person's Codex starts in a terminal: the program and the flags it
  // needs, worked out once per program.
  let codexLaunched: { program: string; command: string[] } | null = null
  const codexLaunch = (): string[] | null => {
    const found = codexTools.cli() ?? codexApp()
    const program = found?.[0]

    if (found === null || program === undefined) return null
    if (codexLaunched?.program !== program) codexLaunched = { program, command: [...found, ...codexTools.launchArgs(program)] }

    return codexLaunched.command
  }

  // Whether Codex trusts ChoiBuddy's hooks (null: not connected, or Codex's
  // app-server could not be asked). With `trust`, records the trust first.
  // The app's codex.exe answers first: that is the Codex that runs the hooks.
  const codexStatus = async (trust: boolean): Promise<CodexState & { trusted: boolean | null; cli: boolean }> => {
    const cli = codexTools.cli()
    const known = codexHome === null ? { installed: false, connected: false } : codexState(codexHome)
    const state = { ...known, installed: known.installed || cli !== null, cli: cli !== null }

    if (!state.connected) return { ...state, trusted: null }
    if (!trust && codexChecked !== null && now() - codexChecked.at < CODEX_CHECK_MS) return { ...state, trusted: codexChecked.trusted }

    // When Windows will not start the app's codex.exe, or it gives no
    // answer, the CLI answers.
    let seen: CodexTrust | null = null

    for (const program of [codexApp(), cli]) {
      if (program !== null && seen === null) seen = await codexTrust([...program, 'app-server'], homedir(), trust)
    }

    const trusted = seen === null ? null : seen.ours > 0 && seen.trusted === seen.ours

    codexChecked = { at: now(), trusted }

    return { ...state, trusted }
  }
  const modManifest = options.modManifest ?? join(homedir(), '.claude', 'local-mods', 'choibuddy', '.claude-plugin', 'plugin.json')
  let modReadAt = 0

  // Read again now and then: installing a new version changes it under us.
  const checkInstalledMod = (): void => {
    if (now() - modReadAt < MOD_CHECK_MS) return
    modReadAt = now()
    store.setInstalledMod(readModVersion(modManifest))
  }

  checkInstalledMod()

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
  // Uploads still in a prompt box: path → the session they were made for.
  const waitingUploads = new Map<string, { sessionId: string; at: number }>()

  // The prompt went out: the pictures it lists join the gallery now.
  const sendUploads = (sessionId: string, text: string): void => {
    const session = store.sessions.get(sessionId)

    for (const [path, upload] of waitingUploads) {
      if (now() - upload.at > UPLOAD_WAIT_MS) waitingUploads.delete(path)
      else if (upload.sessionId === sessionId && text.includes(path)) {
        waitingUploads.delete(path)
        if (session !== undefined) gallery.addFile({ sessionId, sessionName: session.name, tool: 'upload' }, path)
      }
    }
  }
  // Pictures uploaded for this prompt, which Codex then sees as images too,
  // not only as paths in the text.
  const uploadedImages = (sessionId: string, text: string): string[] =>
    [...waitingUploads].flatMap(([path, upload]) => (upload.sessionId === sessionId && text.includes(path) && CODEX_IMAGES.has(imageMime(path) ?? '') ? [path] : []))
  const autoLanguage = new AutoLanguage()
  // First prompts for sessions opened from a device, waiting for them to start.
  const launchPrompts: LaunchPrompt[] = []
  // Claude's browser_view calls waiting for the widget's answer.
  const browserWaits = new Map<string, Held>()

  purgeTrash(trashDir, now())
  const held = new Map<string, HeldApproval>()
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
    autoLanguage: config.autoLanguage,
    chatPush: true,
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

  // Where each session's transcript is, once found (a search of the project
  // folders is too slow to repeat four times a second).
  const chatPaths = new Map<string, string>()

  const chatPath = (sessionId: string): string | null => {
    const known = chatPaths.get(sessionId) ?? transcripts.find(sessionId, store.transcriptPath(sessionId))

    if (known !== null) chatPaths.set(sessionId, known)

    return known
  }

  const liveChats = new LiveChats({
    messages: sessionId => {
      const path = chatPath(sessionId)

      return path === null ? null : transcripts.reader(path).messages
    },
    emit: sendEvent,
    now,
  })

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
  const finish = (id: string, output: JsonObject, decision: Decision | null = null): void => {
    const entry = held.get(id)

    if (entry === undefined) return

    held.delete(id)
    clearTimeout(entry.timer)
    entry.answer(output, decision)

    const alert = store.resolvePending(id)

    if (alert !== null) emit(alert)
    scheduleSnapshot()
  }

  // What Codex's own record of a session adds to its hooks: model and
  // effort, usage and the account's windows, and the pictures it made.
  const codexRollouts = new CodexRollouts()
  const readCodexRecord = (sessionId: string): void => {
    const path = store.transcriptPath(sessionId)
    const reading = path === null ? null : codexRollouts.read(path)

    if (reading !== null && store.applyCodexReading(sessionId, reading)) scheduleSnapshot()
  }

  const handleHook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req, HOOK_BODY_LIMIT)
    const raw = body === null ? null : parseJsonObject(body)
    const parsed = raw === null ? null : parseHookInput(raw)

    // A Codex session that started in one of this PC's terminals takes the
    // place the app showed for that terminal.
    if (parsed !== null && fromCodex(parsed.raw) && !store.follows(parsed.sessionId)) {
      const shown = store.waitingTerminalSession(str(parsed.raw, 'choibuddy_term'), parsed.cwd)

      if (shown !== null) {
        store.alias(parsed.sessionId, shown)
        log(`codex session ${parsed.sessionId} started in terminal ${store.terminalOf(shown) ?? '?'}`)
      }
    }

    const input = parsed === null ? null : store.resolve(parsed)

    // A Codex session ChoiBuddy runs reports through its app-server; its own
    // hooks would tell the same twice. Approvals still come this way.
    if (input === null || (store.isManaged(input.sessionId) && input.event !== 'PermissionRequest')) {
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

      held.set(pending.id, { answer: output => sendJson(res, 200, output), timer })
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

    sendJson(res, 200, {})
    applyHook(input)
  }

  // A hook's event on the store, or one in its shape from a Codex session
  // ChoiBuddy runs itself.
  const applyHook = (input: HookInput): void => {
    const result = store.apply(input)

    if (fromCodex(input.raw)) readCodexRecord(input.sessionId)
    if (input.event === 'UserPromptSubmit') autoLanguage.onPrompt(input.sessionId, str(input.raw, 'prompt') ?? '')

    // The prompt and the turn's reply go to the chat at once, before the
    // transcript file (which can lag, or stop) has them.
    const said = input.event === 'UserPromptSubmit' ? userText(str(input.raw, 'prompt') ?? '') : input.event === 'Stop' ? (str(input.raw, 'last_assistant_message') ?? '').trim() : ''

    if (said !== null && said !== '') liveChats.heard(input.sessionId, { role: input.event === 'Stop' ? 'assistant' : 'user', text: said, at: now() })

    // A reply in another language than the person's: ask for it again in theirs.
    if (input.event === 'Stop') {
      const ask = autoLanguage.onStop(input.sessionId, str(input.raw, 'last_assistant_message') ?? '', config.autoLanguage)

      if (ask !== null) log(`auto language: asked ${input.sessionId} again (${promptSession(input.sessionId, ask, 'queue')})`)
    }

    for (const id of result.cleared) finish(id, {})
    for (const alert of result.alerts) emit(alert)
    scheduleSnapshot()
  }

  // A prompt for a session: Codex ChoiBuddy runs gets it at once, any other
  // through its mod.
  const promptSession = (sessionId: string, text: string, mode: PromptMode): string => {
    if (!store.isManaged(sessionId)) return store.queuePrompt(sessionId, text, mode)
    void chats.send(sessionId, text, mode !== 'queue')

    return 'queued'
  }

  // Codex asks the person in a session ChoiBuddy runs (an approval, a
  // question): answered like any other, approvals also by Auto Accept.
  const askCodex = (raw: JsonObject, answer: (decision: Decision | null) => void): void => {
    const input = parseHookInput(raw)

    if (input === null) {
      answer(null)

      return
    }

    const { pending, alert } = store.addPending(input)

    if (autoAcceptUntil > now() && pending.kind === 'permission') {
      store.resolvePending(pending.id)
      answer({ id: pending.id, behavior: 'allow', message: null, answers: null })
      emit({ ...alert, type: 'auto' })
      scheduleSnapshot()
      log(`auto-accepted ${pending.tool} (${pending.sessionName})`)

      return
    }

    held.set(pending.id, {
      answer: (_output, decision) => answer(decision),
      timer: setTimeout(() => finish(pending.id, {}), holdMs),
    })
    emit(alert)
    scheduleSnapshot()
    log(`pending ${pending.kind} ${pending.tool} (${pending.sessionName}, Codex)`)
  }

  const chats = new CodexChats(
    () => codexTools.cli() ?? codexApp(),
    {
      hook: raw => {
        const input = parseHookInput(raw)

        if (input !== null) applyHook(input)
      },
      reply: (threadId, itemId, text) => {
        const tail = streamTail(text)

        liveChats.write(threadId, `codex:${itemId}`, null, text)

        sendEvent('stream', JSON.stringify({ sessionId: threadId, toolUseId: null, tool: null, path: null, language: 'plain', skippedLines: tail.skippedLines, text: tail.text, at: now() }))
      },
      approval: askCodex,
      picture: (threadId, picture) => {
        if (store.applyCodexReading(threadId, { ...emptyReading(), pictures: [picture] })) scheduleSnapshot()
      },
      limits: windows => {
        store.codexLimits = { windows, at: now() }
        scheduleSnapshot()
      },
      keep: kept => {
        try {
          writeFileSync(codexChatsFile, `${JSON.stringify(kept.slice(-KEPT_CHATS))}\n`)
        } catch (error) {
          log(`codex chats not kept: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      log,
    },
    VERSION,
  )

  // Codex sessions ChoiBuddy ran before this start: back in the list, and
  // resumed in Codex when a message goes to one.
  const codexChatsFile = join(dirname(options.galleryDir), 'codex-chats.json')
  const keptChats = readKeptChats(codexChatsFile)

  chats.remember(keptChats)
  for (const chat of keptChats) store.addKeptCodexChat(chat.id, chat.cwd, chat.path, chat.model, chat.effort, chat.startedAt)

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
      endTermStreams(() => true)
      log('all codes rotated')
      sendJson(res, 200, { ok: true })

      return
    }

    sendJson(res, 404, { ok: false })
  }

  const handleMod = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    // Claude Code's last messages can run long; the rest are small.
    const body = await readBody(req, path === '/mod/messages' ? HOOK_BODY_LIMIT : API_BODY_LIMIT)
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

    // Claude Code's last messages, sent by the mod after each step: they fill
    // in what the transcript file lacks (it can lag, or stop being written).
    if (path === '/mod/messages') {
      const sessionId = str(parsed, 'sessionId')
      const tail: EngineMessage[] = []

      for (const item of objects(arr(parsed, 'messages')).slice(-ENGINE_TAIL)) {
        const role = str(item, 'role')
        const raw = (str(item, 'text') ?? '').slice(0, ENGINE_TEXT)
        const text = role === 'user' ? userText(raw) : raw.trim()

        if ((role === 'user' || role === 'assistant') && text !== null && text !== '') tail.push({ role, text })
      }

      if (sessionId !== null) liveChats.engine(sessionId, tail)
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

      // The reply itself (not a tool's input) also goes to the chat as a draft.
      if (sessionId !== null && tool === null) {
        const key = str(parsed, 'key') ?? LEGACY

        if (bool(parsed, 'done') === true) liveChats.finish(sessionId, key, str(parsed, 'answer') ?? text ?? '')
        else if (text !== null) liveChats.write(sessionId, key, num(parsed, 'seq'), text)
      }

      if (sessionId !== null && text !== null && bool(parsed, 'done') !== true) {
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

      checkInstalledMod()
      if (sessionId !== null && store.noteMod(sessionId, str(parsed, 'mod'), num(parsed, 'loadedAt'))) scheduleSnapshot()

      // Claude Code is open for this session even when the bridge lost it.
      if (sessionId !== null && store.revive(sessionId, () => revival(sessionId))) {
        log(`session ${sessionId} is back: its mod still polls`)
        scheduleSnapshot()
      }

      const stop = sessionId !== null && store.takeStop(sessionId)
      const prompts = sessionId === null ? [] : store.takePrompts(sessionId)
      const commands = sessionId === null ? [] : store.takeCommands(sessionId)
      const session = sessionId === null ? undefined : store.sessions.get(sessionId)
      const first = session === undefined ? null : claimLaunchPrompt(launchPrompts, session.cwd, session.startedAt, now())

      // A session opened from a device gets the prompt typed with it.
      if (first !== null && sessionId !== null) {
        store.queuePrompt(sessionId, first)
        scheduleSnapshot()
      }

      if (prompts.length > 0 || commands.length > 0 || stop) {
        log(`delivering ${stop ? 'a stop, ' : ''}${prompts.length} prompt(s), ${commands.length} command(s) to ${sessionId}`)
        scheduleSnapshot()
      }
      // A bridge that restarted lost the session's commands: the mod sends them again.
      sendJson(res, 200, { ok: true, stop, prompts, commands, needCommands: sessionId !== null && !store.knowsCommands(sessionId) })

      return
    }

    // The session's own turn ended; a stopped one has no Stop hook to say so.
    if (path === '/mod/turn-end') {
      const sessionId = str(parsed, 'sessionId') ?? ''
      const result = store.turnEnded(sessionId)

      if (result !== null) {
        log(`turn ended without a Stop hook in ${sessionId}: idle`)
        for (const id of result.cleared) finish(id, {})
        scheduleSnapshot()
      }
      sendJson(res, 200, { ok: true })

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
    endTermStreams(device => device === deviceId)
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
      for (const draft of liveChats.drafts()) res.write(`event: draft\ndata: ${JSON.stringify(draft)}\n\n`)
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
      finish(decision.id, output, decision)
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

      // A picture joins the gallery once the prompt that lists it is sent,
      // not while it waits in the prompt box.
      if (store.sessions.has(sessionId)) waitingUploads.set(path, { sessionId, at: now() })
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

    // Any device may turn it on (in its own language) or off.
    if (req.method === 'POST' && url.pathname === '/api/auto-language') {
      const body = await readBody(req, API_BODY_LIMIT)
      // An empty or missing language turns it off.
      const requested = str(body === null ? null : parseJsonObject(body), 'lang') ?? ''
      const lang = parseLang(requested)

      if (lang === null && requested !== '') {
        sendJson(res, 400, { ok: false, error: 'unknown language' })

        return
      }

      config.autoLanguage = lang
      options.saveConfig(config)
      log(`auto language ${lang ?? 'off'}`)
      scheduleSnapshot()
      sendJson(res, 200, { ok: true, autoLanguage: lang })

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
          agent: session.agent,
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

      const requestedMode = str(parsed, 'mode') ?? ''
      // "Steer in" stops the running turn and sends at once, as Claude Code's
      // send-now (Ctrl+Enter) does: waiting for the running tool to end felt
      // like nothing happened. Apps that still send "steer" get the same.
      const mode: PromptMode = requestedMode === 'queue' ? 'queue' : 'interrupt'
      const term = store.terminalOf(sessionId)

      // Codex ChoiBuddy runs takes it at once: a turn of its own, or (sent
      // now while it works) after stopping the running one.
      if (store.isManaged(sessionId)) {
        const slash = parseSlash(text)
        const sent =
          slash !== null && CODEX_COMMANDS.some(command => command.name === slash.command)
            ? await chats.command(sessionId, slash.command, slash.args, mode !== 'queue')
            : await chats.send(sessionId, text, mode !== 'queue', uploadedImages(sessionId, text))

        if (sent) sendUploads(sessionId, text)
        log(`prompt for codex ${sessionId}: ${sent ? 'sent' : 'gone'}`)
        sendJson(res, sent ? 200 : 409, { ok: sent, result: sent ? 'queued' : 'no-mod' })

        return
      }

      // A session in one of this PC's terminals (Codex) takes it typed in,
      // its own slash commands too; sending now presses Esc first.
      if (term !== undefined) {
        // Esc only stops a turn that runs: an idle Codex takes it as "edit the last message".
        const status = store.sessions.get(sessionId)?.status
        const typed = terminals.type(term, text, mode === 'interrupt' && (status === 'working' || status === 'thinking' || status === 'waiting'))

        if (typed) sendUploads(sessionId, text)
        log(`prompt typed into terminal ${term} for ${sessionId}: ${typed ? 'ok' : 'gone'}`)
        sendJson(res, typed ? 200 : 409, { ok: typed, result: typed ? 'queued' : 'no-mod' })

        return
      }

      // "/name args" for a command the session offers runs as that command;
      // anything else (also "/" followed by an unknown name) is a prompt.
      const slash = parseSlash(text)
      const known = slash !== null && (ALWAYS_COMMANDS.has(slash.command) || store.commandsFor(sessionId).some(command => command.name === slash.command))
      const result = slash !== null && known ? store.queueCommand(sessionId, slash.command, slash.args) : store.queuePrompt(sessionId, text, mode)

      if (result === 'queued') sendUploads(sessionId, text)
      log(`${known ? 'command' : 'prompt'} for ${sessionId}: ${result}`)
      scheduleSnapshot()
      sendJson(res, result === 'queued' ? 200 : 409, { ok: result === 'queued', result })

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/commands') {
      const session = url.searchParams.get('session') ?? ''

      // Codex ChoiBuddy runs offers Codex's own commands, not Claude's.
      sendJson(res, 200, { ok: true, commands: store.isManaged(session) ? CODEX_COMMANDS : store.commandsFor(session) })

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

    // Loads the session's plugins again, the same as typing /reload-plugins
    // there: a session started before the mod was updated picks it up.
    if (req.method === 'POST' && url.pathname === '/api/sessions/reload') {
      const body = await readBody(req, API_BODY_LIMIT)
      const sessionId = str(body === null ? null : parseJsonObject(body), 'sessionId') ?? ''
      const session = store.sessions.get(sessionId)

      if (session === undefined || session.status === 'ended') {
        sendJson(res, 404, { ok: false, error: 'not open' })

        return
      }

      const result = store.queueCommand(sessionId, RELOAD_COMMAND, '')

      log(`reload plugins in ${sessionId}: ${result}`)
      scheduleSnapshot()
      sendJson(res, result === 'queued' ? 200 : 409, result === 'queued' ? { ok: true } : { ok: false, error: result })

      return
    }

    // Stops the session's running turn, as Esc does in the terminal: the
    // running tool stops too, and what was done stays.
    if (req.method === 'POST' && url.pathname === '/api/sessions/stop') {
      const body = await readBody(req, API_BODY_LIMIT)
      const sessionId = str(body === null ? null : parseJsonObject(body), 'sessionId') ?? ''
      const term = store.terminalOf(sessionId)

      if (store.isManaged(sessionId)) {
        const stopped = await chats.stop(sessionId)

        log(`stop codex ${sessionId}: ${stopped ? 'ok' : 'nothing running'}`)
        sendJson(res, stopped ? 200 : 409, stopped ? { ok: true } : { ok: false, error: 'idle' })

        return
      }

      if (term !== undefined) {
        const pressed = terminals.escape(term)

        log(`stop ${sessionId}: Esc into terminal ${term}`)
        sendJson(res, pressed ? 200 : 409, pressed ? { ok: true } : { ok: false, error: 'no-mod' })

        return
      }

      const result = store.askStop(sessionId)

      log(`stop ${sessionId}: ${result}`)
      sendJson(res, result === 'queued' ? 200 : 409, result === 'queued' ? { ok: true } : { ok: false, error: result })

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

      // Codex ChoiBuddy runs ends here.
      if (store.isManaged(sessionId)) {
        const ended = await chats.end(sessionId)

        log(`ended codex ${sessionId}: ${ended}`)
        sendJson(res, ended ? 200 : 409, { ok: ended })

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

    // Terminals on this PC, shown in the app. The PC's own app may always
    // use them; paired devices once the danger zone allows it.
    if (url.pathname === '/api/term' || url.pathname.startsWith('/api/term/')) {
      const allowed = caller.device === null || config.remoteTerminal

      if (req.method === 'GET' && url.pathname === '/api/term') {
        sendJson(res, 200, { available: terminals.available(), allowed, remote: config.remoteTerminal, terminals: allowed ? terminals.list() : [] })

        return
      }

      if (req.method === 'POST' && url.pathname === '/api/term/remote') {
        if (caller.device !== null) {
          sendJson(res, 403, { ok: false, error: 'owner only' })

          return
        }

        const body = await readBody(req, API_BODY_LIMIT)

        config.remoteTerminal = bool(body === null ? null : parseJsonObject(body), 'on') ?? false
        options.saveConfig(config)
        if (!config.remoteTerminal) endTermStreams(device => device !== null)
        log(`remote terminals ${config.remoteTerminal ? 'on' : 'off'}`)
        sendJson(res, 200, { ok: true, remote: config.remoteTerminal })

        return
      }

      if (!allowed) {
        sendJson(res, 403, { ok: false, error: 'terminals are for this PC only' })

        return
      }

      if (req.method === 'GET' && url.pathname === '/api/term/stream') {
        const id = url.searchParams.get('id') ?? ''
        let pending = ''
        let flush: NodeJS.Timeout | null = null

        // Pieces a few milliseconds apart go out as one event.
        const send = (): void => {
          flush = null
          if (pending === '') return
          res.write(`event: out\ndata: ${JSON.stringify(pending)}\n\n`)
          pending = ''
        }
        const followed = terminals.follow(id, {
          data: chunk => {
            pending += chunk
            flush ??= setTimeout(send, TERM_FLUSH_MS)
          },
          exit: code => {
            send()
            res.write(`event: exit\ndata: ${code}\n\n`)
          },
        })

        if (followed === null) {
          sendJson(res, 404, { ok: false })

          return
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
        res.write(`retry: 2000\nevent: out\ndata: ${JSON.stringify(followed.backlog)}\n\n`)
        if (followed.exited) res.write('event: exit\ndata: 0\n\n')
        termStreams.set(res, caller.device?.id ?? null)
        req.on('close', () => {
          if (flush !== null) clearTimeout(flush)
          followed.stop()
          termStreams.delete(res)
        })

        return
      }

      const body = req.method === 'POST' ? await readBody(req, API_BODY_LIMIT) : null
      const parsed = body === null ? null : parseJsonObject(body)
      const id = str(parsed, 'id') ?? ''

      if (req.method === 'POST' && url.pathname === '/api/term/open') {
        const requested = str(parsed, 'run')
        const run: TermRun = requested === 'claude' || requested === 'codex' ? requested : 'shell'
        const prompt = str(parsed, 'prompt')?.trim() ?? ''
        const opened = terminals.open({ cwd: str(parsed, 'cwd')?.trim() ?? '', run, cols: num(parsed, 'cols') ?? 100, rows: num(parsed, 'rows') ?? 30, title: str(parsed, 'title') ?? '', prompt })

        if (typeof opened === 'string') {
          sendJson(res, 400, { ok: false, error: opened })

          return
        }

        // Claude Code gets its first prompt through the mod once it starts.
        if (run === 'claude' && prompt !== '') launchPrompts.push({ cwd: opened.cwd, text: prompt, at: now() })

        // Codex shows at once; it starts its own session with the first message.
        if (run === 'codex') {
          store.addTerminalSession(opened.id, opened.cwd)
          terminals.follow(opened.id, {
            data: () => {},
            exit: () => {
              if (store.terminalGone(opened.id)) scheduleSnapshot()
            },
          })
          scheduleSnapshot()
        }

        log(`terminal ${opened.id} (${run}) in ${opened.cwd}`)
        sendJson(res, 200, { ok: true, terminal: opened })

        return
      }

      if (req.method === 'POST' && url.pathname === '/api/term/input') {
        sendJson(res, terminals.write(id, str(parsed, 'data') ?? '') ? 200 : 404, {})

        return
      }

      if (req.method === 'POST' && url.pathname === '/api/term/resize') {
        sendJson(res, terminals.resize(id, num(parsed, 'cols') ?? 80, num(parsed, 'rows') ?? 24) ? 200 : 404, {})

        return
      }

      if (req.method === 'POST' && url.pathname === '/api/term/close') {
        if (store.terminalGone(id)) scheduleSnapshot()
        sendJson(res, terminals.close(id) ? 200 : 404, {})

        return
      }

      sendJson(res, 404, { ok: false })

      return
    }

    // Codex on this PC: whether it is there, ChoiBuddy's hooks are listed and
    // Codex trusts them.
    if (req.method === 'GET' && url.pathname === '/api/codex/models') {
      sendJson(res, 200, { ok: true, models: await chats.models() })

      return
    }

    // The model and effort the next turn of a Codex session ChoiBuddy runs uses.
    if (req.method === 'POST' && url.pathname === '/api/codex/settings') {
      const body = await readBody(req, API_BODY_LIMIT)
      const parsed = body === null ? null : parseJsonObject(body)
      const sessionId = str(parsed, 'sessionId') ?? ''
      const model = str(parsed, 'model') || null
      const effort = str(parsed, 'effort') || null
      const set = chats.setSettings(sessionId, model, effort)

      if (set) store.setCodexSettings(sessionId, model, effort)
      scheduleSnapshot()
      sendJson(res, set ? 200 : 404, { ok: set })

      return
    }

    if (req.method === 'GET' && url.pathname === '/api/codex') {
      sendJson(res, 200, await codexStatus(false))

      return
    }

    // Lists ChoiBuddy's hooks in Codex's hooks.json, or takes them out. Only
    // this PC's own app may change another program's settings.
    if (req.method === 'POST' && url.pathname === '/api/codex') {
      if (caller.device !== null) {
        sendJson(res, 403, { ok: false, error: 'owner only' })

        return
      }

      const body = await readBody(req, API_BODY_LIMIT)
      const on = bool(body === null ? null : parseJsonObject(body), 'on') ?? false
      if (codexHome === null) {
        sendJson(res, 404, { ok: false, error: 'no codex' })

        return
      }

      // No `codex` command yet: OpenAI's CLI goes in first (winget). Pressing
      // twice waits for the same install.
      if (on && codexTools.cli() === null) {
        log('installing the Codex CLI')
        codexInstalling ??= codexTools.install().finally(() => {
          codexInstalling = null
        })

        const installed = await codexInstalling

        log(`Codex CLI install ${installed ? 'done' : 'failed'}`)

        if (!installed && codexApp() === null) {
          sendJson(res, 500, { ok: false, error: 'codex cli install failed' })

          return
        }
      }

      // Installed before but `codex` does not run in a terminal: fixed too.
      if (on && codexTools.cli() !== null) codexTools.command()

      setCodexHooks(codexHome, on ? codexHook : null)
      codexChecked = null

      // Trusted the way Codex's own /hooks screen does it, as the person asked.
      const status = await codexStatus(on)

      log(`codex hooks ${on ? 'on' : 'off'}${on ? `, trusted ${String(status.trusted)}` : ''}`)
      sendJson(res, 200, { ok: true, ...status })

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
      const codex = str(parsed, 'agent') === 'codex'

      // Codex ChoiBuddy runs itself: no terminal, the chat is where it lives.
      if (codex && bool(parsed, 'window') !== true) {
        if (!isFolder(cwd)) {
          sendJson(res, 400, { ok: false, error: 'no such folder' })

          return
        }

        const started = await chats.start(cwd, str(parsed, 'model'), str(parsed, 'effort'))

        if (!started.ok) {
          log(`codex chat failed: ${started.error}`)
          sendJson(res, 400, { ok: false, error: started.error })

          return
        }

        store.manage(started.threadId)
        if (prompt !== '') void chats.send(started.threadId, prompt, false)
        log(`codex chat ${started.threadId} in ${cwd}`)
        scheduleSnapshot()
        sendJson(res, 200, { ok: true, terminal: 'ChoiBuddy', sessionId: started.threadId })

        return
      }
      // Codex starts without the first prompt here: a terminal window would
      // split it up as its own arguments. The in-app terminal can pass it.
      const opened = codex ? openTerminal(cwd, codexLaunch() ?? ['codex']) : openSession(cwd)

      if (opened.ok && !codex && prompt !== '') launchPrompts.push({ cwd, text: prompt, at: now() })
      log(opened.ok ? `new ${codex ? 'Codex' : 'Claude'} session in ${cwd} (${opened.terminal})` : `new session failed: ${opened.error}`)
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
    // Codex writes pictures and token counts while it works, between hooks.
    setInterval(() => {
      for (const session of store.sessions.values()) {
        if (session.agent === 'codex' && (session.status === 'working' || session.status === 'thinking')) readCodexRecord(session.id)
      }
    }, CODEX_READ_MS),
    setInterval(() => {
      if (store.prune().length > 0) scheduleSnapshot()
    }, PRUNE_MS),
    setInterval(() => {
      const open: string[] = []

      for (const session of store.sessions.values()) {
        if (session.status === 'ended') continue
        open.push(session.id)
        // A turn that is over has no reply on its way any more.
        if (session.status !== 'working' && session.status !== 'thinking') liveChats.end(session.id)
      }

      liveChats.tick(open)
    }, CHAT_TICK_MS),
    setInterval(() => {
      if (store.expireCommands()) scheduleSnapshot()
    }, HEARTBEAT_MS),
  ]

  if (options.bindTailnet !== false) {
    await syncTailnet()
    timers.push(setInterval(() => void syncTailnet(), TAILNET_CHECK_MS))
  }

  log(`bridge ${VERSION} listening on 127.0.0.1:${port}`)

  // Connected to Codex, but this version writes its hooks differently (or
  // runs from elsewhere): Codex would skip them as changed, so they are
  // written again and trusted again.
  if (codexHome !== null && codexState(codexHome).connected && !codexHooksCurrent(codexHome, codexHook)) {
    setCodexHooks(codexHome, codexHook)
    void codexStatus(true).then(status => log(`codex hooks updated, trusted ${String(status.trusted)}`))
  }

  const close = async (): Promise<void> => {
    terminals.closeAll()
    chats.close()
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
