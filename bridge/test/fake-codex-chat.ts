// Stands in for `codex app-server` in tests: one thread, turns that reply
// "안녕하세요" in two pieces, a command that asks for approval when the
// prompt says "run", and a turn that waits for an interrupt when it says
// "slow". A prompt with "plan" updates the plan, "ask" asks a question,
// "net" asks for the network, "form" sends an MCP server's form; compact
// and review run as turns. Every request it gets is written to the log
// file, one per line.
// With a record path, it writes Codex's record (rollout) of each turn there.
// usage: node fake-codex-chat.ts <log> [record] [anything else is ignored]
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { arr, type Json, type JsonObject, num, obj, objects, parseJsonObject, str } from '../src/json.ts'

const [logPath = '', recordArg = 'app-server'] = process.argv.slice(2)
// `app-server` is what ChoiBuddy adds after the program, not a record.
const recordPath = recordArg === 'app-server' ? null : recordArg
let said = ''

// One line of Codex's record, as its rollout files have them.
function record(type: string, payload: JsonObject): void {
  if (recordPath !== null) appendFileSync(recordPath, `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`)
}
const lines = createInterface({ input: process.stdin })
let nextRequest = 100
let turn = 0
let running: string | null = null
const asked = new Map<number, (result: JsonObject | null) => void>()

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function note(method: string, params: JsonObject): void {
  send({ method, params })
}

function finishTurn(turnId: string, status: string): void {
  running = null
  record('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: `u-${turnId}`, content: [{ type: 'text', text: said }] } })
  if (status === 'completed') record('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: `a-${turnId}`, content: [{ type: 'Text', text: '안녕하세요' }] } })
  note('turn/completed', { threadId: 'th-1', turn: { id: turnId, status } })
}

function reply(turnId: string): void {
  note('item/started', { threadId: 'th-1', turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text: '' } })
  note('item/agentMessage/delta', { threadId: 'th-1', turnId, itemId: `msg-${turnId}`, delta: '안녕' })
  note('item/agentMessage/delta', { threadId: 'th-1', turnId, itemId: `msg-${turnId}`, delta: '하세요' })
  note('item/completed', { threadId: 'th-1', turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text: '안녕하세요' } })
}

// Asks the client, then ends the turn once it answers.
function ask(turnId: string, method: string, params: JsonObject): void {
  const requestId = nextRequest

  nextRequest += 1
  asked.set(requestId, () => {
    reply(turnId)
    finishTurn(turnId, 'completed')
  })
  send({ id: requestId, method, params: { threadId: 'th-1', turnId, ...params } })
}

function startTurn(id: Json, params: JsonObject | null): void {
  turn += 1

  const turnId = `turn-${turn}`
  const text = objects(arr(params, 'input')).map(item => str(item, 'text') ?? '').join(' ')

  running = turnId
  said = text
  send({ id, result: { turn: { id: turnId, status: 'inProgress' } } })

  if (text.includes('slow')) return

  if (text.includes('run')) {
    const command = { type: 'commandExecution', id: 'cmd-1', command: 'echo hi', status: 'inProgress' }
    const requestId = nextRequest

    nextRequest += 1
    note('item/started', { threadId: 'th-1', turnId, item: command })
    asked.set(requestId, result => {
      const decision = str(result, 'decision')
      const done = decision === 'accept' || decision === 'acceptForSession'

      note('item/completed', { threadId: 'th-1', turnId, item: { ...command, status: done ? 'completed' : 'declined', exitCode: done ? 0 : null, aggregatedOutput: done ? 'hi' : null } })
      reply(turnId)
      finishTurn(turnId, 'completed')
    })
    send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: 'th-1', turnId, itemId: 'cmd-1', command: 'echo hi' } })

    return
  }

  if (text.includes('plan')) {
    const plan = [
      { step: 'Read the code', status: 'completed' },
      { step: 'Fix the bug', status: 'inProgress' },
      { step: 'Test it', status: 'pending' },
    ]

    note('turn/plan/updated', { threadId: 'th-1', turnId, explanation: null, plan })
  }

  if (text.includes('ask')) {
    const options = [
      { label: 'Red', description: 'warm' },
      { label: 'Blue', description: 'cool' },
    ]

    ask(turnId, 'item/tool/requestUserInput', { itemId: 'q-1', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'color', header: 'Color', question: 'Which color?', isOther: true, isSecret: false, options }] })

    return
  }

  if (text.includes('net')) {
    ask(turnId, 'item/permissions/requestApproval', { itemId: 'perm-1', environmentId: null, startedAtMs: 0, cwd: '', reason: 'to fetch the docs', permissions: { network: { enabled: true }, fileSystem: null } })

    return
  }

  if (text.includes('form')) {
    ask(turnId, 'mcpServer/elicitation/request', { serverName: 'docs', mode: 'form', _meta: null, message: 'Sign in', requestedSchema: {} })

    return
  }

  reply(turnId)
  finishTurn(turnId, 'completed')
}

// A turn Codex starts by itself: announced before the request is answered.
function ownTurn(): string {
  turn += 1

  const turnId = `turn-${turn}`

  running = turnId
  note('turn/started', { threadId: 'th-1', turn: { id: turnId, status: 'inProgress' } })

  return turnId
}

lines.on('line', line => {
  const message = parseJsonObject(line)

  if (message === null) return
  appendFileSync(logPath, `${line}\n`)

  const method = str(message, 'method')
  const id = message.id ?? null
  const params = obj(message, 'params')

  // An answer to an approval asked above.
  const answered = num(message, 'id')

  if (method === null && answered !== null) {
    asked.get(answered)?.(obj(message, 'result'))
    asked.delete(answered)

    return
  }

  switch (method) {
    case 'initialize':
      send({ id, result: { userAgent: 'fake', codexHome: '', platformFamily: 'windows', platformOs: 'windows' } })
      break
    case 'model/list':
      send({ id, result: { data: [{ id: 'gpt-test', displayName: 'GPT Test', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low', isDefault: true }], nextCursor: null } })
      break
    case 'account/rateLimits/read':
      send({ id, result: { rateLimits: { primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1791797732 }, secondary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: 1792299005 } } } })
      break
    case 'thread/start':
      record('session_meta', { id: 'th-1', cwd: str(params, 'cwd') ?? '' })
      send({ id, result: { thread: { id: 'th-1', path: recordPath }, model: 'gpt-test', reasoningEffort: 'medium', cwd: str(params, 'cwd') } })
      break
    case 'thread/read':
      send({ id, result: { thread: { id: 'th-1', path: recordPath } } })
      break
    case 'turn/start':
      startTurn(id, params)
      break
    case 'thread/compact/start': {
      const turnId = ownTurn()

      send({ id, result: {} })
      note('item/started', { threadId: 'th-1', turnId, item: { type: 'contextCompaction', id: 'compact-1' } })
      note('item/completed', { threadId: 'th-1', turnId, item: { type: 'contextCompaction', id: 'compact-1' } })
      finishTurn(turnId, 'completed')
      break
    }
    case 'review/start': {
      turn += 1

      const turnId = `turn-${turn}`

      running = turnId
      send({ id, result: { turn: { id: turnId, status: 'inProgress' }, reviewThreadId: 'th-1' } })
      reply(turnId)
      finishTurn(turnId, 'completed')
      break
    }
    case 'turn/interrupt':
      send({ id, result: {} })
      if (running !== null) finishTurn(running, 'interrupted')
      break
    default:
      if (id !== null) send({ id, result: {} })
  }
})
