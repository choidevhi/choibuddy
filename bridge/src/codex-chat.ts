// Codex sessions ChoiBuddy runs itself, through Codex's app-server (the way
// Codex's own app runs them): started from New session, prompts and stop
// from any device, model and effort picked here, the reply as it is written,
// and approval requests. What Codex does is handed on in the shape of its
// hooks, so the rest of the bridge shows these sessions like any other.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { CommandInfo, Decision } from '../../shared/protocol.ts'
import { arr, bool, type Json, type JsonObject, num, obj, objects, parseJsonObject, str, strings } from './json.ts'
import type { CodexPicture, CodexWindow } from './codex-rollout.ts'

export type CodexModelInfo = { id: string; name: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean }

// Codex's own commands, run by ChoiBuddy for the sessions it runs.
export const CODEX_COMMANDS: CommandInfo[] = [
  { name: 'compact', description: 'Summarize the conversation so far to free up context', source: 'codex' },
  { name: 'review', description: 'Review the uncommitted changes, or what you write after it', source: 'codex' },
]

export type ChatEvents = {
  // An event in the shape of a Codex hook (session_id, hook_event_name, ...).
  hook: (raw: JsonObject) => void
  // The reply being written, so far.
  reply: (threadId: string, text: string) => void
  // What Codex asks the person (an approval, a question), in the shape of a
  // PermissionRequest hook; null when nobody answered.
  approval: (raw: JsonObject, answer: (decision: Decision | null) => void) => void
  picture: (threadId: string, picture: CodexPicture) => void
  limits: (windows: CodexWindow[]) => void
  // The sessions to keep for the next start of the bridge.
  keep: (chats: KeptChat[]) => void
  log: (line: string) => void
}

// A session ChoiBuddy runs, as kept across restarts of the bridge.
export type KeptChat = { id: string; cwd: string; path: string | null; model: string | null; effort: string | null; startedAt: number }

type Thread = {
  id: string
  // Loaded in this app-server; one kept from before is resumed when used.
  loaded: boolean
  startedAt: number
  cwd: string
  model: string | null
  effort: string | null
  path: string | null
  turn: string | null
  // A turn Codex starts on its own for a command (compact) is this session's.
  adopt: boolean
  // What waits for the running turn; "send now" stops it first.
  queued: Waiting[]
  replyItem: string | null
  reply: string
  lastReply: string
  // Tool items as they started, for their completion and approvals.
  items: Map<string, JsonObject>
  // What runs for this session, one after another.
  chain: Promise<void>
}

// A message (with the pictures sent along) or one of Codex's commands.
type Waiting = { text: string; images: string[]; command: { name: string; args: string } | null }

type Tool = { tool: string; input: JsonObject }

const REQUEST_MS = 60_000
const MODELS_MS = 10 * 60_000

// A Codex file change as an apply_patch text, which ChoiBuddy's previews read.
export function patchText(changes: JsonObject[]): string {
  const files = changes.map(change => {
    const kind = str(obj(change, 'kind'), 'type')
    const head = kind === 'add' ? 'Add File' : kind === 'delete' ? 'Delete File' : 'Update File'
    // A unified diff's own file headers would read as changed lines.
    const body = (str(change, 'diff') ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(line => !line.startsWith('--- ') && !line.startsWith('+++ ') && !line.startsWith('diff --git') && !line.startsWith('index '))

    return [`*** ${head}: ${str(change, 'path') ?? ''}`, ...body].join('\n')
  })

  return ['*** Begin Patch', ...files, '*** End Patch'].join('\n')
}

// What a tool item amounts to as a hook's tool call.
function toolOf(item: JsonObject): Tool | null {
  switch (str(item, 'type')) {
    case 'commandExecution':
      return { tool: 'Bash', input: { command: str(item, 'command') ?? '' } }
    case 'fileChange':
      return { tool: 'apply_patch', input: { command: patchText(objects(arr(item, 'changes'))) } }
    case 'mcpToolCall':
      return { tool: `mcp__${str(item, 'server') ?? 'mcp'}__${str(item, 'tool') ?? 'tool'}`, input: obj(item, 'arguments') ?? {} }
    case 'webSearch':
      return { tool: 'WebSearch', input: { query: str(item, 'query') ?? '' } }
    case 'collabAgentToolCall':
      return agentTool(item)
    default:
      return null
  }
}

// Codex's subagents: one started, or a message to one, as Claude's are shown.
function agentTool(item: JsonObject): Tool | null {
  const prompt = str(item, 'prompt') ?? ''

  switch (str(item, 'tool')) {
    case 'spawnAgent':
      return { tool: 'Agent', input: { description: prompt.split('\n')[0] ?? '', prompt, subagent_type: str(item, 'model') ?? 'Codex agent' } }
    case 'sendInput':
    case 'sendMessage':
    case 'followupTask':
      return { tool: 'SendMessage', input: { message: prompt } }
    default:
      return null
  }
}

// Codex's plan as the todo list Claude keeps.
function planTodos(plan: JsonObject[]): JsonObject[] {
  return plan.map(step => {
    const status = str(step, 'status')

    return { content: str(step, 'step') ?? '', status: status === 'inProgress' ? 'in_progress' : status === 'completed' ? 'completed' : 'pending' }
  })
}

// What Codex asks to be allowed beyond its sandbox, in a line.
function permissionsLine(reason: string | null, permissions: JsonObject | null): string {
  const files = obj(permissions, 'fileSystem')
  const parts = [...strings(arr(files, 'write')).map(path => `write ${path}`), ...strings(arr(files, 'read')).map(path => `read ${path}`)]

  if (bool(obj(permissions, 'network'), 'enabled') === true) parts.unshift('network')

  const asked = parts.join(' · ')

  return reason === null || reason === '' ? asked : asked === '' ? reason : `${reason} — ${asked}`
}

// What the person grants: what Codex asked for, for this turn or the session.
function grantedPermissions(asked: JsonObject | null, decision: Decision | null): JsonObject {
  const permissions: JsonObject = {}

  if (decision === null || decision.behavior === 'deny') return { permissions, scope: 'turn' }

  const network = obj(asked, 'network')
  const fileSystem = obj(asked, 'fileSystem')

  if (network !== null) permissions.network = network
  if (fileSystem !== null) permissions.fileSystem = fileSystem

  return { permissions, scope: decision.behavior === 'always' ? 'session' : 'turn' }
}

// Codex's questions as AskUserQuestion's, and the answers back by question id.
function questionsInput(questions: JsonObject[]): JsonObject {
  return {
    questions: questions.map(question => ({
      question: str(question, 'question') ?? '',
      header: str(question, 'header') ?? '',
      multiSelect: false,
      options: objects(arr(question, 'options')).map(option => ({ label: str(option, 'label') ?? '', description: str(option, 'description') ?? '' })),
    })),
  }
}

function questionAnswers(questions: JsonObject[], decision: Decision | null): JsonObject {
  const answers: JsonObject = {}

  for (const question of questions) {
    const id = str(question, 'id')
    const answer = decision === null || decision.behavior === 'deny' ? undefined : decision.answers?.[str(question, 'question') ?? '']

    if (id !== null && answer !== undefined) answers[id] = { answers: [answer] }
  }

  return { answers }
}

// What a finished tool item printed, and whether it failed.
function resultOf(item: JsonObject): { output: string; failed: boolean; declined: boolean } {
  const status = str(item, 'status') ?? ''
  const declined = status === 'declined'
  const exit = num(item, 'exitCode')
  const output = str(item, 'aggregatedOutput') ?? str(obj(item, 'error'), 'message') ?? ''

  return { output, failed: declined || status === 'failed' || (exit !== null && exit !== 0), declined }
}

function windowsOf(snapshot: JsonObject | null): CodexWindow[] {
  return [obj(snapshot, 'primary'), obj(snapshot, 'secondary')].flatMap(limit => {
    const used = num(limit, 'usedPercent')

    if (limit === null || used === null) return []

    const minutes = num(limit, 'windowDurationMins')
    const resets = num(limit, 'resetsAt')
    const kind = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day' : minutes === null ? 'window' : `${minutes}m`

    return [{ kind, percentUsed: used, resetsAt: resets === null ? null : new Date(resets * 1000).toISOString() }]
  })
}

export class CodexChats {
  readonly #program: () => string[] | null
  readonly #events: ChatEvents
  readonly #version: string
  readonly #threads = new Map<string, Thread>()
  readonly #waiting = new Map<number, (reply: JsonObject | null) => void>()
  #child: ChildProcessWithoutNullStreams | null = null
  #ready: Promise<boolean> | null = null
  #closed = false
  #buffered = ''
  #nextId = 1
  #plans = 0
  #models: { at: number; list: CodexModelInfo[] } | null = null

  constructor(program: () => string[] | null, events: ChatEvents, version: string) {
    this.#program = program
    this.#events = events
    this.#version = version
  }

  has(threadId: string): boolean {
    return this.#threads.has(threadId)
  }

  busy(threadId: string): boolean {
    const thread = this.#threads.get(threadId)

    return thread !== undefined && thread.turn !== null
  }

  // Codex's models, each with the efforts it takes.
  async models(): Promise<CodexModelInfo[]> {
    if (this.#models !== null && Date.now() - this.#models.at < MODELS_MS) return this.#models.list

    const reply = await this.#request('model/list', {})
    const list = objects(arr(obj(reply, 'result'), 'data')).flatMap(model => {
      const id = str(model, 'id')

      if (id === null || bool(model, 'hidden') === true) return []

      return [
        {
          id,
          name: str(model, 'displayName') ?? id,
          efforts: objects(arr(model, 'supportedReasoningEfforts')).flatMap(option => str(option, 'reasoningEffort') ?? []),
          defaultEffort: str(model, 'defaultReasoningEffort'),
          isDefault: bool(model, 'isDefault') === true,
        },
      ]
    })

    if (list.length > 0) this.#models = { at: Date.now(), list }

    return list
  }

  // The Codex account's 5-hour and weekly windows.
  async readLimits(): Promise<void> {
    const reply = await this.#request('account/rateLimits/read', {})
    const windows = windowsOf(obj(obj(reply, 'result'), 'rateLimits'))

    if (windows.length > 0) this.#events.limits(windows)
  }

  // Starts a Codex session in `cwd`: its id, or why it could not start.
  async start(cwd: string, model: string | null, effort: string | null): Promise<{ ok: true; threadId: string } | { ok: false; error: string }> {
    const reply = await this.#request('thread/start', { cwd, model })
    const result = obj(reply, 'result')
    const thread = obj(result, 'thread')
    const id = str(thread, 'id')

    if (id === null) return { ok: false, error: str(obj(reply, 'error'), 'message') ?? 'Codex did not start' }

    const state: Thread = {
      id,
      loaded: true,
      startedAt: Date.now(),
      cwd: str(result, 'cwd') ?? cwd,
      model: str(result, 'model') ?? model,
      effort: effort ?? str(result, 'reasoningEffort'),
      path: str(thread, 'path'),
      turn: null,
      adopt: false,
      queued: [],
      replyItem: null,
      reply: '',
      lastReply: '',
      items: new Map(),
      chain: Promise.resolve(),
    }

    this.#threads.set(id, state)
    this.#hook(state, 'SessionStart', { source: 'startup' })
    this.#keep()
    void this.readLimits()

    return { ok: true, threadId: id }
  }

  // Sessions from before a restart of the bridge: known again, resumed in
  // Codex when a message goes to one.
  remember(chats: KeptChat[]): void {
    for (const chat of chats) {
      if (this.#threads.has(chat.id)) continue
      this.#threads.set(chat.id, { ...chat, loaded: false, turn: null, adopt: false, queued: [], replyItem: null, reply: '', lastReply: '', items: new Map(), chain: Promise.resolve() })
    }
  }

  #keep(): void {
    this.#events.keep([...this.#threads.values()].map(({ id, cwd, path, model, effort, startedAt }) => ({ id, cwd, path, model, effort, startedAt })))
  }

  // A kept session goes back into Codex before it is used.
  async #load(thread: Thread): Promise<boolean> {
    if (thread.loaded) return true

    const reply = await this.#request('thread/resume', { threadId: thread.id, cwd: thread.cwd, excludeTurns: true })

    thread.loaded = obj(reply, 'result') !== null
    if (!thread.loaded) this.#events.log(`codex thread ${thread.id} did not resume: ${str(obj(reply, 'error'), 'message') ?? 'no answer'}`)

    return thread.loaded
  }

  settings(threadId: string): { model: string | null; effort: string | null } | null {
    const thread = this.#threads.get(threadId)

    return thread === undefined ? null : { model: thread.model, effort: thread.effort }
  }

  // The model and effort the next turn runs with.
  setSettings(threadId: string, model: string | null, effort: string | null): boolean {
    const thread = this.#threads.get(threadId)

    if (thread === undefined) return false
    thread.model = model ?? thread.model
    thread.effort = effort ?? thread.effort
    this.#keep()

    return true
  }

  // A message for the session, with pictures Codex sees as images: a turn of
  // its own when it is idle; while it works, `now` stops the turn and the
  // message goes next, else it waits.
  send(threadId: string, text: string, now: boolean, images: string[] = []): Promise<boolean> {
    return this.#take(threadId, { text, images, command: null }, now)
  }

  // One of Codex's commands (CODEX_COMMANDS), as a message would go.
  command(threadId: string, name: string, args: string, now: boolean): Promise<boolean> {
    return this.#take(threadId, { text: args === '' ? `/${name}` : `/${name} ${args}`, images: [], command: { name, args } }, now)
  }

  async #take(threadId: string, waiting: Waiting, now: boolean): Promise<boolean> {
    const thread = this.#threads.get(threadId)

    if (thread === undefined) return false

    return this.#run(
      thread,
      async () => {
        if (!(await this.#load(thread))) return false
        if (thread.turn === null) return this.#begin(thread, [waiting])

        thread.queued.push(waiting)
        if (now) await this.#request('turn/interrupt', { threadId, turnId: thread.turn })

        return true
      },
      false,
    )
  }

  // Stops the running turn, as Esc does; messages sent before still go next.
  async stop(threadId: string): Promise<boolean> {
    const thread = this.#threads.get(threadId)

    if (thread === undefined) return false

    return this.#run(
      thread,
      async () => {
        if (thread.turn === null) return false

        const reply = await this.#request('turn/interrupt', { threadId, turnId: thread.turn })

        return reply !== null && obj(reply, 'error') === null
      },
      false,
    )
  }

  // Ends a session: its running turn stops and Codex lets it go.
  async end(threadId: string): Promise<boolean> {
    const thread = this.#threads.get(threadId)

    if (thread === undefined) return false

    return this.#run(
      thread,
      async () => {
        if (thread.turn !== null) await this.#request('turn/interrupt', { threadId, turnId: thread.turn })
        if (thread.loaded) await this.#request('thread/unsubscribe', { threadId })
        this.#threads.delete(threadId)
        this.#keep()
        this.#hook(thread, 'SessionEnd', { reason: 'other' })

        return true
      },
      false,
    )
  }

  // One thing at a time per session: a turn's start is known before its
  // end is handled, even when Codex answers both at once.
  #run<T>(thread: Thread, task: () => Promise<T>, fallback: T): Promise<T> {
    const done = thread.chain.then(task, task)

    thread.chain = done.then(
      () => undefined,
      () => undefined,
    )

    return done.catch(() => fallback)
  }

  close(): void {
    this.#closed = true
    // An app-server behind npm's codex.cmd ends when its input does.
    this.#child?.stdin.end()
    this.#child?.kill()
    this.#child = null
    this.#ready = null
    for (const resolve of this.#waiting.values()) resolve(null)
    this.#waiting.clear()
  }

  // Starts what waits: messages go together as one turn, a command on its
  // own; what comes after a command waits for that command's turn to end.
  async #begin(thread: Thread, waiting: Waiting[]): Promise<boolean> {
    const first = waiting[0]

    if (first === undefined) return true

    if (first.command !== null) {
      thread.queued.unshift(...waiting.slice(1))

      return this.#runCommand(thread, first.text, first.command.name, first.command.args)
    }

    const end = waiting.findIndex(item => item.command !== null)
    const messages = end === -1 ? waiting : waiting.slice(0, end)

    thread.queued.unshift(...waiting.slice(messages.length))

    return this.#startTurn(
      thread,
      messages.map(message => message.text).join('\n\n'),
      messages.flatMap(message => message.images),
    )
  }

  async #startTurn(thread: Thread, text: string, images: string[]): Promise<boolean> {
    // The prompt is in before Codex can ask anything: a new prompt clears
    // the approvals still out, and Codex may ask in the same breath as it
    // answers turn/start.
    this.#hook(thread, 'UserPromptSubmit', { prompt: text })

    const reply = await this.#request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text, text_elements: [] }, ...images.map(path => ({ type: 'localImage', path }))],
      model: thread.model,
      effort: thread.effort,
    })
    const turn = str(obj(obj(reply, 'result'), 'turn'), 'id')

    if (turn === null) return this.#failed(thread, reply)
    thread.turn = turn

    return true
  }

  async #runCommand(thread: Thread, text: string, name: string, args: string): Promise<boolean> {
    this.#hook(thread, 'UserPromptSubmit', { prompt: text })

    if (name === 'compact') {
      // Codex answers before it compacts; the turn that does it shows up on its own.
      thread.adopt = true

      const reply = await this.#request('thread/compact/start', { threadId: thread.id })

      if (reply !== null && obj(reply, 'result') !== null) return true
      thread.adopt = false

      return this.#failed(thread, reply)
    }

    // review: the changes not yet committed, or what was written after it.
    const target: JsonObject = args === '' ? { type: 'uncommittedChanges' } : { type: 'custom', instructions: args }
    const reply = await this.#request('review/start', { threadId: thread.id, target, delivery: 'inline' })
    const turn = str(obj(obj(reply, 'result'), 'turn'), 'id')

    if (turn === null) return this.#failed(thread, reply)
    thread.turn = turn

    return true
  }

  // Codex did not take it: why shows on the session.
  #failed(thread: Thread, reply: JsonObject | null): false {
    const error = str(obj(reply, 'error'), 'message') ?? 'no answer'

    this.#events.log(`codex turn did not start in ${thread.id}: ${error}`)
    this.#hook(thread, 'StopFailure', { error })

    return false
  }

  #hook(thread: Thread, event: string, fields: JsonObject): void {
    this.#events.hook({
      hook_event_name: event,
      session_id: thread.id,
      cwd: thread.cwd,
      agent: 'codex',
      model: thread.model,
      transcript_path: thread.path,
      permission_mode: 'default',
      ...fields,
    })
  }

  #ensure(): Promise<boolean> {
    // Work still under way when the bridge closes never starts Codex again.
    if (this.#closed) return Promise.resolve(false)
    this.#ready ??= this.#launch()

    return this.#ready
  }

  async #launch(): Promise<boolean> {
    const command = this.#program()
    const [program, ...args] = command ?? []

    if (program === undefined) return false

    let child: ChildProcessWithoutNullStreams

    try {
      // npm's codex.cmd runs through the shell.
      child = spawn(program, [...args, 'app-server'], { stdio: 'pipe', windowsHide: true, shell: program.toLowerCase().endsWith('.cmd') })
    } catch (error) {
      this.#events.log(`codex app-server did not start: ${error instanceof Error ? error.message : String(error)}`)

      return false
    }

    this.#child = child
    this.#buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.#read(chunk))
    child.stderr.on('data', () => {})
    child.on('error', error => this.#events.log(`codex app-server: ${error.message}`))
    child.on('exit', () => this.#gone(child))

    const reply = await this.#call('initialize', { clientInfo: { name: 'choibuddy', title: 'ChoiBuddy', version: this.#version }, capabilities: null })

    if (reply === null || obj(reply, 'result') === null) {
      child.kill()

      return false
    }

    this.#write({ method: 'initialized' })

    return true
  }

  // The app-server went away: running turns end, the next call starts it again.
  #gone(child: ChildProcessWithoutNullStreams): void {
    if (this.#child !== child) return
    this.#child = null
    this.#ready = null
    for (const resolve of this.#waiting.values()) resolve(null)
    this.#waiting.clear()

    for (const thread of this.#threads.values()) {
      thread.loaded = false
      if (thread.turn === null) continue
      thread.turn = null
      this.#hook(thread, 'Stop', { last_assistant_message: thread.lastReply })
    }
  }

  async #request(method: string, params: JsonObject): Promise<JsonObject | null> {
    if (!(await this.#ensure())) return null

    return this.#call(method, params)
  }

  #call(method: string, params: JsonObject): Promise<JsonObject | null> {
    const id = this.#nextId

    this.#nextId += 1

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id)
        resolve(null)
      }, REQUEST_MS)

      // A request still out never keeps the bridge from closing.
      timer.unref()

      this.#waiting.set(id, reply => {
        clearTimeout(timer)
        resolve(reply)
      })
      this.#write({ method, id, params })
    })
  }

  #write(message: JsonObject): void {
    this.#child?.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #read(chunk: string): void {
    this.#buffered += chunk

    const lines = this.#buffered.split('\n')

    this.#buffered = lines.pop() ?? ''

    for (const line of lines) {
      const message = parseJsonObject(line)

      if (message === null) continue

      const method = str(message, 'method')
      const answered = num(message, 'id')

      if (method === null && answered !== null) {
        this.#waiting.get(answered)?.(message)
        this.#waiting.delete(answered)
      } else if (method !== null && message.id !== undefined) {
        this.#serverRequest(message.id, method, obj(message, 'params'))
      } else if (method !== null) {
        this.#notification(method, obj(message, 'params'))
      }
    }
  }

  #notification(method: string, params: JsonObject | null): void {
    if (method === 'account/rateLimits/updated') {
      const windows = windowsOf(obj(params, 'rateLimits'))

      if (windows.length > 0) this.#events.limits(windows)

      return
    }

    const thread = this.#threads.get(str(params, 'threadId') ?? '')

    if (thread === undefined) return

    switch (method) {
      case 'item/agentMessage/delta': {
        const itemId = str(params, 'itemId')

        if (itemId !== thread.replyItem) {
          thread.replyItem = itemId
          thread.reply = ''
        }
        thread.reply += str(params, 'delta') ?? ''
        this.#events.reply(thread.id, thread.reply)
        break
      }
      case 'item/started':
        this.#itemStarted(thread, obj(params, 'item'))
        break
      case 'item/completed':
        this.#itemCompleted(thread, obj(params, 'item'))
        break
      case 'turn/started':
        // The turn Codex starts for a command (compact) is this session's.
        if (thread.adopt && thread.turn === null) {
          thread.adopt = false
          thread.turn = str(obj(params, 'turn'), 'id')
        }
        break
      case 'turn/plan/updated':
        this.#plan(thread, params)
        break
      case 'turn/completed':
        void this.#run(thread, () => this.#turnCompleted(thread, obj(params, 'turn')), undefined)
        break
      case 'error':
        if (bool(params, 'willRetry') !== true) thread.lastReply = str(obj(params, 'error'), 'message') ?? thread.lastReply
        break
      default:
        break
    }
  }

  #itemStarted(thread: Thread, item: JsonObject | null): void {
    const id = str(item, 'id')
    const tool = item === null ? null : toolOf(item)

    if (item === null || id === null || tool === null) return
    thread.items.set(id, item)
    this.#hook(thread, 'PreToolUse', { tool_name: tool.tool, tool_input: tool.input, tool_use_id: id })
  }

  #itemCompleted(thread: Thread, item: JsonObject | null): void {
    const id = str(item, 'id')
    const type = str(item, 'type')

    if (item === null || id === null) return

    if (type === 'agentMessage') {
      thread.lastReply = str(item, 'text') ?? thread.lastReply

      return
    }

    // A compaction that ran without a turn of its own is done here.
    if (type === 'contextCompaction' && thread.adopt && thread.turn === null) {
      thread.adopt = false
      this.#hook(thread, 'Stop', { last_assistant_message: thread.lastReply })

      return
    }

    // Pictures Codex made or opened.
    const saved = type === 'imageGeneration' ? str(item, 'savedPath') : type === 'imageView' ? str(item, 'path') : null

    if (saved !== null) {
      this.#events.picture(thread.id, { path: saved, at: Date.now(), tool: type === 'imageGeneration' ? 'image_gen' : 'view_image' })

      return
    }

    const tool = toolOf(thread.items.get(id) ?? item)

    if (tool === null) return
    thread.items.delete(id)

    const result = resultOf(item)

    this.#hook(thread, result.failed ? 'PostToolUseFailure' : 'PostToolUse', {
      tool_name: tool.tool,
      tool_input: tool.input,
      tool_use_id: id,
      tool_response: result.output,
      error: result.failed ? result.output : null,
      is_interrupt: result.declined,
    })
  }

  async #turnCompleted(thread: Thread, turn: JsonObject | null): Promise<void> {
    // Only the turn this session runs; one started elsewhere is not ours to end.
    if (thread.turn === null || str(turn, 'id') !== thread.turn) return
    thread.turn = null
    thread.replyItem = null
    thread.reply = ''

    // Codex's record of the session exists once a turn ran: its path lets
    // the chat read the conversation, and the record its usage and pictures.
    if (thread.path === null) {
      const reply = await this.#request('thread/read', { threadId: thread.id })

      thread.path = str(obj(obj(reply, 'result'), 'thread'), 'path')
      this.#keep()
    }

    const status = str(turn, 'status')

    this.#hook(thread, status === 'interrupted' ? 'Interrupt' : 'Stop', { last_assistant_message: thread.lastReply })

    await this.#begin(thread, thread.queued.splice(0))
  }

  // Codex's plan, shown as Claude's todo list is.
  #plan(thread: Thread, params: JsonObject | null): void {
    const input = { todos: planTodos(objects(arr(params, 'plan'))) }

    this.#plans += 1

    const id = `plan-${this.#plans}`

    this.#hook(thread, 'PreToolUse', { tool_name: 'TodoWrite', tool_input: input, tool_use_id: id })
    this.#hook(thread, 'PostToolUse', { tool_name: 'TodoWrite', tool_input: input, tool_use_id: id, tool_response: '' })
  }

  // Codex asks the person: a command, a file change or more than its sandbox
  // allows to approve, or questions to answer. An MCP server's form is
  // declined, and anything else ChoiBuddy cannot show is refused, so Codex
  // goes on either way.
  #serverRequest(id: Json, method: string, params: JsonObject | null): void {
    const thread = this.#threads.get(str(params, 'threadId') ?? '')
    const ask = thread === undefined ? null : askOf(thread, method, params)

    if (thread !== undefined && ask !== null) {
      const raw: JsonObject = {
        hook_event_name: 'PermissionRequest',
        session_id: thread.id,
        cwd: thread.cwd,
        agent: 'codex',
        model: thread.model,
        permission_mode: 'default',
        tool_name: ask.tool.tool,
        tool_input: ask.tool.input,
      }

      // Offers "Always allow": Codex's own "for this session".
      if (ask.always) raw.permission_suggestions = [{ type: 'codexSession' }]
      this.#events.approval(raw, decision => this.#write({ id, result: ask.answer(decision) }))

      return
    }

    if (method === 'mcpServer/elicitation/request') {
      this.#write({ id, result: { action: 'decline', content: null, _meta: null } })

      return
    }

    this.#write({ id, error: { code: -32601, message: 'ChoiBuddy does not answer this' } })
  }
}

type Ask = { tool: Tool; always: boolean; answer: (decision: Decision | null) => JsonObject }

// What Codex asks, as the tool call the person sees and the answer it takes.
function askOf(thread: Thread, method: string, params: JsonObject | null): Ask | null {
  const item = thread.items.get(str(params, 'itemId') ?? '') ?? null

  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { tool: { tool: 'Bash', input: { command: str(params, 'command') ?? str(item, 'command') ?? '' } }, always: true, answer: decision => ({ decision: approvalOf(decision) }) }
    case 'item/fileChange/requestApproval':
      return { tool: { tool: 'apply_patch', input: { command: patchText(objects(arr(item, 'changes'))) } }, always: true, answer: decision => ({ decision: approvalOf(decision) }) }
    case 'item/permissions/requestApproval': {
      const permissions = obj(params, 'permissions')

      return {
        tool: { tool: 'Permissions', input: { request: permissionsLine(str(params, 'reason'), permissions) } },
        always: true,
        answer: decision => grantedPermissions(permissions, decision),
      }
    }
    case 'item/tool/requestUserInput': {
      const questions = objects(arr(params, 'questions'))

      return { tool: { tool: 'AskUserQuestion', input: questionsInput(questions) }, always: false, answer: decision => questionAnswers(questions, decision) }
    }
    default:
      return null
  }
}

function approvalOf(decision: Decision | null): string {
  if (decision === null || decision.behavior === 'deny') return 'decline'

  return decision.behavior === 'always' ? 'acceptForSession' : 'accept'
}
