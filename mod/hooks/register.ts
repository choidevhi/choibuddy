// ChoiBuddy's half inside Claude Code. Settings hooks carry what Claude does;
// this mod adds what only the engine knows (context fill, the account's
// 5-hour and weekly windows, token use per request, which model and effort
// each request uses, the slash commands on offer), delivers prompts and slash
// commands typed in the widget or on the phone, and lets Claude look at the
// page open in the widget's browser.
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit, TurnStepChunk, TurnUsage } from 'claude-code'

const BRIDGE = 'http://127.0.0.1:47130'
const POLL_MS = 1500
const BROWSER_TOOL = 'browser_view'

type UsageReport = {
  sessionId: string
  context?: SessionContextUsage
  rateLimits?: readonly SessionRateLimit[]
  cost?: SessionCost
  step?: TurnUsage
}

type PollReply = {
  prompts?: Array<{ id?: string; text?: string; mode?: string }>
  commands?: Array<{ id?: string; command?: string; args?: string }>
}

// How a prompt from a device meets a turn that is still running: steer (the
// turn stops right after the tool that is running finishes, and the message
// goes in as the person's next prompt, so nothing is cut off midway), queue
// (wait for the turn to end), or interrupt (stop now and go).
export type Delivery = 'steer' | 'queue' | 'interrupt'

export type QueuedPrompt = {
  id: string
  text: string
  mode: Delivery
}

function deliveryOf(value: string | undefined): Delivery {
  return value === 'queue' || value === 'interrupt' ? value : 'steer'
}

export type QueuedCommand = {
  id: string
  command: string
  args: string
}

type BrowserReply = {
  ok?: boolean
  url?: string
  title?: string
  imagePath?: string | null
  picked?: string | null
  error?: string
}

async function send($: EngineInterface, path: string, body: string): Promise<string | null> {
  try {
    const res = await $.http.fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })

    return res.ok ? res.text : null
  } catch {
    // The bridge is not running: nothing to report to, nothing to deliver.
    return null
  }
}

function report($: EngineInterface, usage: UsageReport): Promise<string | null> {
  return send($, '/mod/usage', JSON.stringify(usage))
}

// The bridge's reply is its own JSON; only text prompts are taken from it.
export function promptsOf(reply: string): QueuedPrompt[] {
  try {
    const parsed: PollReply = JSON.parse(reply)
    const prompts: QueuedPrompt[] = []

    for (const [index, prompt] of (parsed.prompts ?? []).entries()) {
      if (typeof prompt.text === 'string' && prompt.text.trim() !== '') {
        prompts.push({ id: typeof prompt.id === 'string' ? prompt.id : `p${index}`, text: prompt.text, mode: deliveryOf(prompt.mode) })
      }
    }

    return prompts
  } catch {
    return []
  }
}

// Several messages sent mid-turn go in as one prompt, in the order sent.
export function joinPrompts(prompts: QueuedPrompt[]): string {
  return prompts.map(prompt => prompt.text.trim()).join('\n\n')
}

// The main loop's running turn, and messages waiting for it to reach a tool
// boundary. (Text riding along with a tool result is not used: Claude rightly
// treats instructions found in tool output as untrusted.)
let runningTurn: string | null = null
const steering: QueuedPrompt[] = []
// The gap between a tool result going in and the turn being stopped, so the
// result is recorded first.
const STEER_AFTER_MS = 30

// Sends what was steered as the person's next prompt, stopping the turn first
// when one is running; the bridge learns which queued prompts went.
async function steerNow($: EngineInterface, sessionId: string): Promise<void> {
  const taken = steering.splice(0)

  if (taken.length === 0) return

  const turnId = runningTurn

  if (turnId !== null) await $.turn.abort({ turnId }).catch(() => undefined)
  void send($, '/mod/steered', JSON.stringify({ sessionId, ids: taken.map(prompt => prompt.id) }))
  await $.prompt.submit({ text: joinPrompts(taken), asUser: true }).catch(() => undefined)
}

// Slash commands from the same reply, by name without the slash.
export function commandsOf(reply: string): QueuedCommand[] {
  try {
    const parsed: PollReply = JSON.parse(reply)
    const commands: QueuedCommand[] = []

    for (const item of parsed.commands ?? []) {
      if (typeof item.id === 'string' && typeof item.command === 'string' && item.command !== '') {
        commands.push({ id: item.id, command: item.command, args: typeof item.args === 'string' ? item.args : '' })
      }
    }

    return commands
  } catch {
    return []
  }
}

// What Claude reads from the browser tool: where the page is, the picture to
// open, and the element the person picked, if any.
export function browserText(reply: string | null): string {
  if (reply === null) return 'ChoiBuddy is not running, so its browser cannot be seen.'

  try {
    const parsed: BrowserReply = JSON.parse(reply)

    if (parsed.ok !== true) return parsed.error ?? 'The ChoiBuddy browser did not answer.'

    const lines = [`Page in the ChoiBuddy browser: ${parsed.url ?? ''}${parsed.title === undefined || parsed.title === '' ? '' : ` (${parsed.title})`}`]

    if (typeof parsed.imagePath === 'string') lines.push(`Screenshot of what the person sees: ${parsed.imagePath} (open it with the Read tool).`)
    if (typeof parsed.picked === 'string' && parsed.picked !== '') lines.push(`Element the person picked:\n${parsed.picked}`)

    return lines.join('\n')
  } catch {
    return 'The ChoiBuddy browser sent an answer that could not be read.'
  }
}

async function runCommand($: EngineInterface, sessionId: string, queued: QueuedCommand): Promise<void> {
  let text = ''
  let failed = false

  try {
    const result = await $.command.run({ command: queued.command, args: queued.args })

    text = result.text ?? ''
  } catch (error) {
    failed = true
    text = error instanceof Error ? error.message : String(error)
  }

  await send($, '/mod/command-result', JSON.stringify({ sessionId, id: queued.id, command: queued.command, args: queued.args, text, failed }))
}

async function poll($: EngineInterface, sessionId: string): Promise<void> {
  const reply = await send($, '/mod/poll', JSON.stringify({ sessionId }))

  if (reply === null) return

  for (const prompt of promptsOf(reply)) {
    // With no turn running every mode simply starts one.
    if (runningTurn !== null && prompt.mode === 'steer') {
      steering.push(prompt)
      continue
    }

    if (runningTurn !== null && prompt.mode === 'interrupt') await $.turn.abort({ turnId: runningTurn }).catch(() => undefined)
    // A queued one becomes its own turn once the session is idle.
    await $.prompt.submit({ text: prompt.text, asUser: true })
  }

  for (const command of commandsOf(reply)) await runCommand($, sessionId, command)
}

async function reportCommands($: EngineInterface, sessionId: string): Promise<void> {
  const commands = (await $.command.list()).map(command => ({ name: command.name, description: command.description, source: command.source }))

  await send($, '/mod/commands', JSON.stringify({ sessionId, commands }))
}

// Tools whose input is code worth watching as it is written.
const LIVE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const STREAM_EVERY_MS = 80

type Block = {
  id: string
  name: string
  json: string
}

// Collects what the model is writing in one request (reply text, and the
// input of code-writing tools) and sends it to the bridge many times a
// second, without holding up the stream. The screen smooths it word by word.
class LiveStreamer {
  readonly #post: (body: string) => void
  readonly #sessionId: string
  readonly #blocks = new Map<number, Block>()
  #text = ''
  #sentAt = 0
  #dirty: 'text' | number | null = null

  constructor(post: (body: string) => void, sessionId: string) {
    this.#post = post
    this.#sessionId = sessionId
  }

  chunk(chunk: TurnStepChunk): void {
    switch (chunk.kind) {
      case 'text':
        this.#text += chunk.text
        this.#dirty = 'text'
        break
      case 'tool':
        this.#blocks.set(chunk.index, { id: chunk.id, name: chunk.name, json: '' })
        break
      case 'input': {
        const block = this.#blocks.get(chunk.index)

        if (block === undefined || !LIVE_TOOLS.has(block.name)) return
        block.json += chunk.json
        this.#dirty = chunk.index
        break
      }
      default:
        return
    }

    if (Date.now() - this.#sentAt >= STREAM_EVERY_MS) this.#flush()
  }

  finish(): void {
    this.#flush()
  }

  #flush(): void {
    const dirty = this.#dirty

    if (dirty === null) return

    this.#dirty = null
    this.#sentAt = Date.now()

    const block = dirty === 'text' ? undefined : this.#blocks.get(dirty)
    const body =
      block === undefined
        ? { sessionId: this.#sessionId, text: this.#text }
        : { sessionId: this.#sessionId, toolUseId: block.id, tool: block.name, json: block.json }

    this.#post(JSON.stringify(body))
  }
}

// Last model and effort sent per session and agent, so only changes go out.
const lastModel = new Map<string, string>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const sessionId = await $.session.id()
    const usage = await $.session.usage()

    await report($, { sessionId, context: usage.context, rateLimits: usage.rateLimits, cost: usage.cost })
    $.clock.every(POLL_MS, () => void poll($, sessionId))
    // Neither may keep the session from starting.
    await reportCommands($, sessionId).catch(() => undefined)
    await $.tool.register({
      name: BROWSER_TOOL,
      description:
        "Looks at the web page open in the ChoiBuddy browser on the person's PC: its address, a screenshot of what they see, and the element they picked, if any. Use it when they ask you to look at the page or the element they chose.",
      inputSchema: { type: 'object', properties: {} },
    }).catch(() => undefined)

    return result
  })

  on('session.measure', async ($, e, next) => {
    await report($, { sessionId: await $.session.id(), context: e.context, rateLimits: e.rateLimits, cost: e.cost })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    runningTurn = e.turnId

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined && e.turnId === runningTurn) {
      runningTurn = null
      // A turn that ended before reaching a tool boundary: the messages start
      // the next one.
      if (steering.length > 0) await steerNow($, await $.session.id().catch(() => ''))
    }

    return result
  })

  // Once a tool of the main loop has finished and its result is in, a
  // message sent mid-turn stops the turn and goes in as the next prompt;
  // Claude carries on from everything so far, with the message on top.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined && steering.length > 0 && runningTurn !== null) {
      const sessionId = await $.session.id().catch(() => '')

      $.clock.after(STEER_AFTER_MS, () => void steerNow($, sessionId))
    }

    return result
  })

  // The name is spelled out so the matcher can be read without running it.
  on('tool.call', { tool: 'mcp__choibuddy__browser_view' }, async $ => {
    const reply = await $.session.id().then(
      sessionId => send($, '/mod/browser-view', JSON.stringify({ sessionId })),
      () => null,
    )

    return { result: browserText(reply) }
  })

  on('turn.step', async function* ($, e, next) {
    const sessionId = await $.session.id()
    const key = `${sessionId}|${e.agentId ?? ''}`
    const model = `${e.model}|${e.effort ?? ''}`

    if (lastModel.get(key) !== model) {
      lastModel.set(key, model)
      void send($, '/mod/step', JSON.stringify({ sessionId, agentId: e.agentId ?? null, model: e.model, effort: e.effort === undefined ? null : String(e.effort) }))
    }

    // Only the main conversation streams; subagents show up through hooks.
    const post = (body: string): void => void send($, '/mod/stream', body)
    const live = e.agentId === undefined ? new LiveStreamer(post, sessionId) : null
    const stream = next(e)

    for (;;) {
      const step = await stream.next()

      if (step.done === true) {
        live?.finish()
        if (step.value.usage !== null) await report($, { sessionId, step: step.value.usage })

        return step.value
      }

      yield step.value
      live?.chunk(step.value)
    }
  })
}
