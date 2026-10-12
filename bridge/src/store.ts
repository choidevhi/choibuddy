import type {
  Agent,
  Alert,
  AlertType,
  CommandInfo,
  CommandResult,
  PromptMode,
  Decision,
  Limits,
  Pending,
  PendingKind,
  Preview,
  Question,
  ServerInfo,
  RateLimit,
  Session,
  SessionStatus,
  SessionUsage,
  Snapshot,
  Step,
} from '../../shared/protocol.ts'
import { PROTOCOL_VERSION } from '../../shared/protocol.ts'
import { type Gallery, imageMime, inlineImages } from './gallery.ts'
import { arr, bool, type Json, type JsonObject, num, obj, objects, str } from './json.ts'
import { baseName, type FileReader, kindOf, resultPreview, stepTitle, todosOf, toolPreview } from './previews.ts'

const MAX_STEPS = 40
const PREVIEW_STEPS = 8
const MAX_AGENT_STEPS = 12
const AGENT_PREVIEW_STEPS = 4
const MAX_AGENTS = 8
const ENDED_TTL_MS = 30 * 60_000
const IDLE_TTL_MS = 12 * 60 * 60_000

export type HookInput = {
  event: string
  sessionId: string
  cwd: string
  mode: string | null
  raw: JsonObject
}

export function parseHookInput(raw: JsonObject): HookInput | null {
  const event = str(raw, 'hook_event_name')
  const sessionId = str(raw, 'session_id')

  if (event === null || sessionId === null) return null

  return { event, sessionId, cwd: str(raw, 'cwd') ?? '', mode: str(raw, 'permission_mode'), raw }
}

type PendingEntry = {
  pending: Pending
  toolInput: JsonObject
  suggestions: Json[]
}

export type ApplyResult = {
  alerts: Alert[]
  cleared: string[]
}

export type StoreDeps = {
  read: FileReader
  now: () => number
  newId: () => string
  gallery: Gallery
}

const IMAGE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit'])

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function sameInput(a: JsonObject, b: JsonObject): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

type Outgoing = {
  id: string
  text: string
  mode: PromptMode
  at: number
  taken: boolean
}

type OutgoingCommand = {
  id: string
  command: string
  args: string
  at: number
  taken: boolean
}

const MAX_COMMAND_LOG = 6
const COMMAND_TEXT_LIMIT = 6000

// "/effort high" → { command: "effort", args: "high" }; null when it is not a slash command.
export function parseSlash(text: string): { command: string; args: string } | null {
  const match = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())

  if (match?.[1] === undefined) return null

  return { command: match[1], args: (match[2] ?? '').trim() }
}

export type QueueResult = 'queued' | 'no-session' | 'no-mod'

// What the bridge knows about a session it is about to bring back: its
// folder, its transcript and when it last did something.
export type Revival = { cwd: string; transcript: string; at: number }

// The mod polls every 1.5 s; a few missed polls mean it is gone.
const MOD_ALIVE_MS = 10_000
const OUTGOING_TTL_MS = 10 * 60_000

export class Store {
  readonly sessions = new Map<string, Session>()
  readonly pending = new Map<string, PendingEntry>()
  limits: Limits | null = null
  readonly #modSeen = new Map<string, number>()
  // Sessions Claude Code ended while this bridge ran. A mod that still polls
  // for one does not bring it back.
  readonly #ended = new Set<string>()
  // Names people gave sessions in ChoiBuddy; shown instead of the folder's.
  readonly #names = new Map<string, string>()
  readonly #transcripts = new Map<string, string>()
  readonly #outgoing = new Map<string, Outgoing[]>()
  readonly #commandsOut = new Map<string, OutgoingCommand[]>()
  readonly #commands = new Map<string, CommandInfo[]>()
  // The newest list any session reported. Built-in commands are the same in
  // every session, so one whose own list is unknown (the bridge restarted,
  // an older mod) borrows this one.
  #latestCommands: CommandInfo[] | null = null
  readonly #agentModels = new Map<string, string>()
  readonly #deps: StoreDeps

  constructor(deps: StoreDeps) {
    this.#deps = deps
  }

  // null goes back to the folder's name.
  setName(sessionId: string, name: string | null): void {
    if (name === null) this.#names.delete(sessionId)
    else this.#names.set(sessionId, name)
  }

  #nameOf(session: Session): string {
    return this.#names.get(session.id) ?? session.name
  }

  transcriptPath(sessionId: string): string | null {
    return this.#transcripts.get(sessionId) ?? null
  }

  #session(input: HookInput): Session {
    const now = this.#deps.now()
    const existing = this.sessions.get(input.sessionId)
    const transcript = str(input.raw, 'transcript_path')

    if (transcript !== null && transcript !== '') this.#transcripts.set(input.sessionId, transcript)

    if (existing !== undefined) {
      existing.updatedAt = now
      // Claude cds around while it works; the session keeps the folder it
      // started in, except when a new SessionStart says otherwise.
      if (input.cwd !== '' && (input.event === 'SessionStart' || existing.cwd === '')) {
        existing.cwd = input.cwd
        existing.name = baseName(input.cwd)
      }
      if (input.mode !== null) existing.mode = input.mode

      return existing
    }

    const session = this.#create(input.sessionId, input.cwd, input.mode ?? 'default', now)

    this.sessions.set(session.id, session)

    return session
  }

  #create(id: string, cwd: string, mode: string, at: number): Session {
    return {
      id,
      name: cwd === '' ? 'Claude' : baseName(cwd),
      cwd,
      status: 'idle',
      mode,
      startedAt: at,
      updatedAt: at,
      turnStartedAt: at,
      prompt: null,
      message: null,
      steps: [],
      todos: [],
      subagents: 0,
      toolCount: 0,
      usage: null,
      agents: [],
      canPrompt: false,
      queued: [],
      commandLog: [],
      canCommand: false,
    }
  }

  // The mod polls only while Claude Code is open. A session it polls for
  // that the bridge does not know (the bridge restarted, or the session sat
  // idle for a long time) is still open, so it comes back as idle and takes
  // prompts again. `find` runs only when the session may come back; null
  // when there is no transcript to show for it.
  revive(sessionId: string, find: () => Revival | null): boolean {
    if (this.sessions.has(sessionId) || this.#ended.has(sessionId)) return false

    const found = find()

    if (found === null) return false

    const session = this.#create(sessionId, found.cwd, 'default', found.at)

    this.sessions.set(sessionId, session)
    this.#transcripts.set(sessionId, found.transcript)

    return true
  }

  #alert(type: AlertType, session: Session, text: string, pending: Pending | null): Alert {
    return {
      type,
      sessionId: session.id,
      sessionName: this.#nameOf(session),
      text,
      pendingId: pending?.id ?? null,
      pendingKind: pending?.kind ?? null,
      at: this.#deps.now(),
    }
  }

  #settle(session: Session): void {
    const now = this.#deps.now()

    for (const step of session.steps) {
      if (step.status === 'running') {
        step.status = 'done'
        step.endedAt = now
      }
    }
  }

  #idleStatus(session: Session): SessionStatus {
    if (this.#pendingOf(session.id).length > 0) return 'waiting'

    return session.steps.some(step => step.status === 'running') ? 'working' : 'thinking'
  }

  #pendingOf(sessionId: string): PendingEntry[] {
    return [...this.pending.values()].filter(entry => entry.pending.sessionId === sessionId)
  }

  #clearPending(sessionId: string, matches: (entry: PendingEntry) => boolean): Pending[] {
    const cleared: Pending[] = []

    for (const entry of this.#pendingOf(sessionId)) {
      if (!matches(entry)) continue
      this.pending.delete(entry.pending.id)
      cleared.push(entry.pending)
    }

    return cleared
  }

  #trimSteps(steps: Step[], max: number, withPreview: number): void {
    if (steps.length > max) steps.splice(0, steps.length - max)

    const keepFrom = steps.length - withPreview

    steps.forEach((step, index) => {
      if (index < keepFrom) step.preview = null
    })
  }

  #findStep(steps: Step[], toolUseId: string | null, tool: string): Step | null {
    if (toolUseId !== null) {
      const byId = steps.find(step => step.id === toolUseId)

      if (byId !== undefined) return byId
    }

    return steps.findLast(step => step.tool === tool && step.status === 'running') ?? null
  }

  // Images a finished call produced: a picture file it wrote, or screenshots
  // a tool (a browser, computer use) returned inline. Read is handled when
  // the call starts, from the file itself.
  #imageFrom(session: Session, tool: string, input: JsonObject, response: Json | undefined): Preview | null {
    const origin = { sessionId: session.id, sessionName: session.name, tool }
    const filePath = str(input, 'file_path') ?? ''

    if (IMAGE_WRITERS.has(tool) && imageMime(filePath) !== null) {
      const image = this.#deps.gallery.addFile(origin, filePath)

      return image === null ? null : { type: 'image', imageId: image.id, name: image.name }
    }

    if (tool === 'Read') return null

    let last: Preview | null = null

    for (const inline of inlineImages(response)) {
      const image = this.#deps.gallery.addCapture(origin, inline)

      if (image !== null) last = { type: 'image', imageId: image.id, name: image.name }
    }

    return last
  }

  // Tool calls made inside a subagent carry its agent_id and go on that
  // agent's own list, so the main list stays the main thread's.
  #agent(session: Session, raw: JsonObject): Agent | null {
    const agentId = str(raw, 'agent_id')

    if (agentId === null) return null

    const existing = session.agents.find(agent => agent.id === agentId)

    if (existing !== undefined) return existing

    const taken = new Set(session.agents.map(agent => agent.description))
    const launcher = session.steps.findLast(step => step.kind === 'agent' && step.status === 'running' && !taken.has(step.title))
    const agent: Agent = {
      id: agentId,
      type: str(raw, 'agent_type') ?? 'agent',
      description: launcher?.title ?? '',
      status: 'running',
      startedAt: this.#deps.now(),
      endedAt: null,
      steps: [],
      message: null,
      model: this.#agentModels.get(agentId) ?? null,
    }

    session.agents.push(agent)
    if (session.agents.length > MAX_AGENTS) {
      const finished = session.agents.findIndex(item => item.status === 'done')

      session.agents.splice(finished === -1 ? 0 : finished, 1)
    }
    session.subagents = session.agents.filter(item => item.status === 'running').length

    return agent
  }

  apply(input: HookInput): ApplyResult {
    const session = this.#session(input)
    const raw = input.raw
    const now = this.#deps.now()
    const alerts: Alert[] = []
    let cleared: Pending[] = []

    switch (input.event) {
      case 'SessionStart': {
        if (str(raw, 'source') === 'clear') {
          session.steps = []
          session.todos = []
          session.prompt = null
          session.message = null
          session.toolCount = 0
        }
        if (session.status === 'ended') session.status = 'idle'
        this.#ended.delete(session.id)
        break
      }
      case 'UserPromptSubmit': {
        this.#settle(session)
        cleared = this.#clearPending(session.id, () => true)
        session.agents = session.agents.filter(agent => agent.status === 'running')
        session.prompt = str(raw, 'prompt')
        session.message = null
        session.status = 'thinking'
        session.turnStartedAt = now
        this.#delivered(session.id, session.prompt ?? '')
        break
      }
      case 'PreToolUse': {
        const tool = str(raw, 'tool_name') ?? 'Tool'
        const toolInput = obj(raw, 'tool_input') ?? {}
        const step: Step = {
          id: str(raw, 'tool_use_id') ?? this.#deps.newId(),
          tool,
          kind: kindOf(tool),
          title: stepTitle(tool, toolInput),
          status: 'running',
          startedAt: now,
          endedAt: null,
          preview: toolPreview(tool, toolInput, this.#deps.read),
          agent: str(raw, 'agent_type'),
        }

        const agent = this.#agent(session, raw)
        const filePath = str(toolInput, 'file_path') ?? ''

        // Looking at a picture: keep it for the gallery and show it.
        if (tool === 'Read' && imageMime(filePath) !== null) {
          const image = this.#deps.gallery.addFile({ sessionId: session.id, sessionName: session.name, tool }, filePath)

          if (image !== null) step.preview = { type: 'image', imageId: image.id, name: image.name }
        }

        if (tool === 'TodoWrite' && agent === null) session.todos = todosOf(toolInput)
        session.toolCount += 1
        session.status = this.#pendingOf(session.id).length > 0 ? 'waiting' : 'working'

        if (agent === null) {
          session.steps.push(step)
          this.#trimSteps(session.steps, MAX_STEPS, PREVIEW_STEPS)
        } else {
          agent.steps.push(step)
          this.#trimSteps(agent.steps, MAX_AGENT_STEPS, AGENT_PREVIEW_STEPS)
        }
        break
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const tool = str(raw, 'tool_name') ?? 'Tool'
        const toolInput = obj(raw, 'tool_input') ?? {}
        const failed = input.event === 'PostToolUseFailure'
        const error = failed ? (str(raw, 'error') ?? '') : null
        const steps = this.#agent(session, raw)?.steps ?? session.steps
        const step = this.#findStep(steps, str(raw, 'tool_use_id'), tool)

        if (step !== null) {
          step.status = failed ? (bool(raw, 'is_interrupt') === true ? 'denied' : 'failed') : 'done'
          step.endedAt = now
          step.preview = step.preview?.type === 'image' ? step.preview : resultPreview(tool, step.preview, raw.tool_response, error)

          const image = failed ? null : this.#imageFrom(session, tool, toolInput, raw.tool_response)

          if (image !== null) step.preview = image
        }

        cleared = this.#clearPending(session.id, entry => entry.pending.tool === tool && sameInput(entry.toolInput, toolInput))
        session.status = this.#idleStatus(session)
        break
      }
      case 'PermissionDenied': {
        const steps = this.#agent(session, raw)?.steps ?? session.steps
        const step = this.#findStep(steps, str(raw, 'tool_use_id'), str(raw, 'tool_name') ?? 'Tool')

        if (step !== null) {
          step.status = 'denied'
          step.endedAt = now
        }
        break
      }
      case 'Notification': {
        const type = str(raw, 'notification_type')
        const message = str(raw, 'message') ?? ''

        if (type === 'permission_prompt') {
          session.status = 'waiting'
        } else if (type !== 'idle_prompt' && message !== '') {
          alerts.push(this.#alert('notice', session, clip(message, 160), null))
        }
        break
      }
      case 'Stop': {
        this.#settle(session)
        cleared = this.#clearPending(session.id, () => true)
        session.status = 'done'
        session.message = str(raw, 'last_assistant_message') ?? session.message
        alerts.push(this.#alert('done', session, clip(session.message ?? '', 160), null))
        break
      }
      case 'StopFailure': {
        this.#settle(session)
        cleared = this.#clearPending(session.id, () => true)
        session.status = 'error'
        alerts.push(this.#alert('error', session, clip(str(raw, 'error') ?? str(raw, 'message') ?? '', 160), null))
        break
      }
      case 'SubagentStart': {
        this.#agent(session, raw)
        break
      }
      case 'SubagentStop': {
        const agent = this.#agent(session, raw)

        if (agent !== null) {
          agent.status = 'done'
          agent.endedAt = now
          agent.message = str(raw, 'last_assistant_message') ?? agent.message
          for (const step of agent.steps) {
            if (step.status === 'running') {
              step.status = 'done'
              step.endedAt = now
            }
          }
        }
        session.subagents = session.agents.filter(item => item.status === 'running').length
        break
      }
      case 'SessionEnd': {
        this.#settle(session)
        cleared = this.#clearPending(session.id, () => true)
        session.status = 'ended'
        this.#ended.add(session.id)
        break
      }
      default:
        break
    }

    for (const pending of cleared) alerts.push(this.#alert('resolved', session, '', pending))

    return { alerts, cleared: cleared.map(pending => pending.id) }
  }

  addPending(input: HookInput): { pending: Pending; alert: Alert } {
    const session = this.#session(input)
    const raw = input.raw
    const tool = str(raw, 'tool_name') ?? 'Tool'
    const toolInput = obj(raw, 'tool_input') ?? {}
    const kind = pendingKind(tool)
    const questions = kind === 'question' ? parseQuestions(toolInput) : []
    const suggestions = arr(raw, 'permission_suggestions')
    const pending: Pending = {
      id: this.#deps.newId(),
      sessionId: session.id,
      sessionName: this.#nameOf(session),
      kind,
      tool,
      detail: pendingDetail(kind, tool, toolInput, questions),
      preview: toolPreview(tool, toolInput, this.#deps.read),
      canAlwaysAllow: kind === 'permission' && suggestions.length > 0,
      questions,
      plan: kind === 'plan' ? str(toolInput, 'plan') : null,
      createdAt: this.#deps.now(),
    }

    this.pending.set(pending.id, { pending, toolInput, suggestions })
    session.status = 'waiting'

    return { pending, alert: this.#alert('pending', session, pending.detail, pending) }
  }

  // Removes a pending request however it ended (decided, timed out, the
  // terminal answered first) and returns the alert that tells clients.
  resolvePending(id: string): Alert | null {
    const entry = this.pending.get(id)

    if (entry === undefined) return null

    this.pending.delete(id)

    const session = this.sessions.get(entry.pending.sessionId)

    if (session === undefined) return null
    if (session.status === 'waiting') session.status = this.#idleStatus(session)

    return this.#alert('resolved', session, '', entry.pending)
  }

  decisionOutput(id: string, decision: Decision): JsonObject | null {
    const entry = this.pending.get(id)

    if (entry === undefined) return null

    return permissionOutput(entry, decision)
  }

  // Figures the companion mod reports: the context window, account rate
  // limits, cost, and each model request's token use.
  applyUsage(body: JsonObject): boolean {
    const sessionId = str(body, 'sessionId')

    if (sessionId === null) return false

    const now = this.#deps.now()
    const windows = objects(arr(body, 'rateLimits')).map(
      (limit): RateLimit => ({ kind: str(limit, 'kind') ?? '', percentUsed: num(limit, 'percentUsed') ?? 0, resetsAt: str(limit, 'resetsAt') }),
    )

    this.#modSeen.set(sessionId, now)
    if (windows.length > 0) this.limits = { windows, at: now }

    const session = this.sessions.get(sessionId)

    if (session === undefined) return windows.length > 0

    const usage = this.#usageOf(session)
    const context = obj(body, 'context')
    const step = obj(body, 'step')

    if (context !== null) {
      usage.contextPercent = num(context, 'percent') ?? usage.contextPercent
      usage.contextTokens = num(context, 'tokens') ?? usage.contextTokens
      usage.contextWindow = num(context, 'window') ?? usage.contextWindow
    }

    usage.costUsd = num(obj(body, 'cost'), 'usd') ?? usage.costUsd

    if (step !== null) {
      usage.model = str(step, 'model') ?? usage.model
      usage.inputTokens += num(step, 'input_tokens') ?? 0
      usage.outputTokens += num(step, 'output_tokens') ?? 0
      usage.cacheReadTokens += num(step, 'cache_read_input_tokens') ?? 0
      usage.cacheWriteTokens += num(step, 'cache_creation_input_tokens') ?? 0
    }

    session.usage = usage

    return true
  }

  #usageOf(session: Session): SessionUsage {
    return session.usage ?? {
      model: null,
      effort: null,
      contextPercent: null,
      contextTokens: null,
      contextWindow: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    }
  }

  // Which model and effort a request uses, from the mod: the main thread's
  // goes on the session, a subagent's on that agent (kept until the agent's
  // first hook arrives, which may come later).
  applyStep(body: JsonObject): boolean {
    const sessionId = str(body, 'sessionId')
    const model = str(body, 'model')

    if (sessionId === null || model === null) return false

    this.#modSeen.set(sessionId, this.#deps.now())

    const agentId = str(body, 'agentId')
    const session = this.sessions.get(sessionId)

    if (agentId !== null) {
      this.#agentModels.set(agentId, model)

      const agent = session?.agents.find(item => item.id === agentId)

      if (agent !== undefined) agent.model = model

      return agent !== undefined
    }

    if (session === undefined) return false

    const usage = this.#usageOf(session)

    usage.model = model
    usage.effort = str(body, 'effort')
    session.usage = usage

    return true
  }

  // The mod reports a session's commands when the session starts; a bridge
  // that restarted since has none and asks again on the next poll.
  knowsCommands(sessionId: string): boolean {
    return this.#commands.has(sessionId)
  }

  setCommands(sessionId: string, commands: CommandInfo[]): void {
    this.#commands.set(sessionId, commands)
    if (commands.length > 0) this.#latestCommands = commands
  }

  // A list kept from before the bridge started.
  seedCommands(commands: CommandInfo[]): void {
    if (commands.length > 0) this.#latestCommands = commands
  }

  commandsFor(sessionId: string): CommandInfo[] {
    return this.#commands.get(sessionId) ?? this.#latestCommands ?? []
  }

  queueCommand(sessionId: string, command: string, args: string): QueueResult {
    const now = this.#deps.now()

    if (!this.sessions.has(sessionId)) return 'no-session'
    if (!this.#modAlive(sessionId, now)) return 'no-mod'

    const list = this.#commandsOut.get(sessionId) ?? []

    list.push({ id: this.#deps.newId(), command, args, at: now, taken: false })
    this.#commandsOut.set(sessionId, list)

    return 'queued'
  }

  takeCommands(sessionId: string): Array<{ id: string; command: string; args: string }> {
    const fresh = (this.#commandsOut.get(sessionId) ?? []).filter(item => !item.taken)
    const handed: Array<{ id: string; command: string; args: string }> = []

    for (const item of fresh) {
      item.taken = true
      handed.push({ id: item.id, command: item.command, args: item.args })
    }

    return handed
  }

  // What a command printed, from the mod; it leaves the queue and joins the log.
  commandResult(body: JsonObject): boolean {
    const sessionId = str(body, 'sessionId')
    const id = str(body, 'id')

    if (sessionId === null || id === null) return false

    const list = this.#commandsOut.get(sessionId) ?? []
    const index = list.findIndex(item => item.id === id)

    if (index !== -1) list.splice(index, 1)
    if (list.length === 0) this.#commandsOut.delete(sessionId)

    const session = this.sessions.get(sessionId)

    if (session === undefined) return false

    const text = str(body, 'text') ?? ''
    const result: CommandResult = {
      id,
      command: str(body, 'command') ?? '',
      args: str(body, 'args') ?? '',
      text: text.length > COMMAND_TEXT_LIMIT ? `${text.slice(0, COMMAND_TEXT_LIMIT)}…` : text,
      failed: bool(body, 'failed') === true,
      at: this.#deps.now(),
    }

    session.commandLog = [...session.commandLog, result].slice(-MAX_COMMAND_LOG)

    return true
  }

  queuePrompt(sessionId: string, text: string, mode: PromptMode = 'steer'): QueueResult {
    const now = this.#deps.now()

    if (!this.sessions.has(sessionId)) return 'no-session'
    if (!this.#modAlive(sessionId, now)) return 'no-mod'

    const list = this.#outgoing.get(sessionId) ?? []

    list.push({ id: this.#deps.newId(), text, mode, at: now, taken: false })
    this.#outgoing.set(sessionId, list)

    return 'queued'
  }

  // The mod's poll: hands over prompts not yet taken. They stay listed as
  // queued until Claude Code reports them submitted (it waits for the
  // session to be idle first).
  takePrompts(sessionId: string): Array<{ id: string; text: string; mode: PromptMode }> {
    this.#modSeen.set(sessionId, this.#deps.now())

    const handed: Array<{ id: string; text: string; mode: PromptMode }> = []

    for (const item of this.#outgoing.get(sessionId) ?? []) {
      if (item.taken) continue
      item.taken = true
      handed.push({ id: item.id, text: item.text, mode: item.mode })
    }

    return handed
  }

  // The mod steered these in (joined into one prompt, so the prompt's text
  // does not match any of them): they leave the queue by id.
  steered(sessionId: string, ids: string[]): boolean {
    const list = this.#outgoing.get(sessionId)

    if (list === undefined) return false

    const before = list.length

    for (const id of ids) {
      const index = list.findIndex(item => item.id === id)

      if (index !== -1) list.splice(index, 1)
    }

    if (list.length === 0) this.#outgoing.delete(sessionId)

    return list.length !== before
  }

  #modAlive(sessionId: string, now: number): boolean {
    const seen = this.#modSeen.get(sessionId)

    return seen !== undefined && now - seen <= MOD_ALIVE_MS
  }

  #delivered(sessionId: string, prompt: string): void {
    const list = this.#outgoing.get(sessionId)

    if (list === undefined) return

    const index = list.findIndex(item => item.text.trim() === prompt.trim())

    if (index !== -1) list.splice(index, 1)
    if (list.length === 0) this.#outgoing.delete(sessionId)
  }

  prune(): string[] {
    const now = this.#deps.now()
    const removed: string[] = []

    for (const session of this.sessions.values()) {
      const ttl = session.status === 'ended' ? ENDED_TTL_MS : IDLE_TTL_MS
      // Quiet for hours, but Claude Code is still open: keep it.
      const open = session.status !== 'ended' && this.#modAlive(session.id, now)

      if (!open && now - session.updatedAt > ttl && this.#pendingOf(session.id).length === 0) {
        this.sessions.delete(session.id)
        this.#modSeen.delete(session.id)
        this.#outgoing.delete(session.id)
        this.#commandsOut.delete(session.id)
        this.#commands.delete(session.id)
        removed.push(session.id)
      }
    }

    for (const [sessionId, list] of this.#outgoing) {
      const kept = list.filter(item => now - item.at < OUTGOING_TTL_MS)

      if (kept.length === 0) this.#outgoing.delete(sessionId)
      else this.#outgoing.set(sessionId, kept)
    }

    return removed
  }

  dismiss(sessionId: string): boolean {
    if (this.#pendingOf(sessionId).length > 0) return false

    return this.sessions.delete(sessionId)
  }

  snapshot(server: ServerInfo): Snapshot {
    const sessions = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    const counts = new Map<string, number>()

    for (const session of sessions) counts.set(this.#nameOf(session), (counts.get(this.#nameOf(session)) ?? 0) + 1)

    const now = this.#deps.now()
    // Two sessions in the same folder are told apart by their ids; a name
    // the person picked is shown as it is.
    const named = sessions.map(session => ({
      ...session,
      name:
        this.#names.has(session.id) || counts.get(this.#nameOf(session)) === 1
          ? this.#nameOf(session)
          : `${session.name} · ${session.id.slice(0, 4)}`,
      canPrompt: this.#modAlive(session.id, now),
      canCommand: this.#modAlive(session.id, now) && (this.#commands.has(session.id) || this.#latestCommands !== null),
      queued: [
        ...(this.#outgoing.get(session.id) ?? []).map(item => ({ text: item.text, mode: item.mode })),
        ...(this.#commandsOut.get(session.id) ?? []).map(item => ({ text: `/${item.command}${item.args === '' ? '' : ` ${item.args}`}`, mode: 'command' as const })),
      ],
    }))
    const names = new Map(named.map(session => [session.id, session.name]))
    const pending = [...this.pending.values()]
      .map(entry => ({ ...entry.pending, sessionName: names.get(entry.pending.sessionId) ?? entry.pending.sessionName }))
      .sort((a, b) => a.createdAt - b.createdAt)

    return { protocol: PROTOCOL_VERSION, serverTime: now, server, sessions: named, pending, limits: this.limits, gallery: this.#deps.gallery.summary() }
  }
}

function pendingKind(tool: string): PendingKind {
  if (tool === 'AskUserQuestion') return 'question'
  if (tool === 'ExitPlanMode') return 'plan'

  return 'permission'
}

function parseQuestions(input: JsonObject): Question[] {
  return objects(arr(input, 'questions')).map(question => ({
    question: str(question, 'question') ?? '',
    header: str(question, 'header') ?? '',
    multiSelect: bool(question, 'multiSelect') === true,
    options: objects(arr(question, 'options')).map(option => ({
      label: str(option, 'label') ?? '',
      description: str(option, 'description') ?? '',
    })),
  }))
}

function pendingDetail(kind: PendingKind, tool: string, input: JsonObject, questions: Question[]): string {
  if (kind === 'question') return clip(questions[0]?.question ?? '', 140)
  if (kind === 'plan') return ''
  if (kindOf(tool) === 'bash') return clip(str(input, 'command') ?? '', 140)

  return stepTitle(tool, input)
}

// Builds the PermissionRequest hook answer Claude Code expects. Questions
// and plan approval need updatedInput, or Claude Code ignores an allow for
// tools that require the person to interact.
export function permissionOutput(entry: PendingEntry, decision: Decision): JsonObject {
  const kind = entry.pending.kind

  if (decision.behavior === 'deny') {
    return hookAnswer({ behavior: 'deny', message: decision.message ?? 'The user denied this from ChoiBuddy (widget or phone).' })
  }

  if (kind === 'question') {
    return hookAnswer({ behavior: 'allow', updatedInput: { ...entry.toolInput, answers: decision.answers ?? {} } })
  }

  if (kind === 'plan') {
    return hookAnswer({ behavior: 'allow', updatedInput: entry.toolInput })
  }

  if (decision.behavior === 'always' && entry.suggestions.length > 0) {
    return hookAnswer({ behavior: 'allow', updatedPermissions: entry.suggestions })
  }

  return hookAnswer({ behavior: 'allow' })
}

function hookAnswer(decision: JsonObject): JsonObject {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}
