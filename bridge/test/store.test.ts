import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Decision } from '../../shared/protocol.ts'
import type { JsonObject } from '../src/json.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Gallery } from '../src/gallery.ts'
import { editPreview } from '../src/previews.ts'
import { type HookInput, parseHookInput, Store } from '../src/store.ts'

const SERVER = { pcId: 'pc-1', hostName: 'pc', tailnetUrl: null, version: 'test', autoAcceptUntil: 0, trustTailnet: false, autoLanguage: null }

function makeStore(files: Record<string, string> = {}): { store: Store; tick: (ms: number) => void } {
  let now = 1_000
  let id = 0
  const newId = (): string => `id-${++id}`
  const store = new Store({
    read: path => files[path] ?? null,
    now: () => now,
    newId,
    gallery: new Gallery(mkdtempSync(join(tmpdir(), 'choibuddy-gallery-')), () => now, newId),
  })

  return { store, tick: ms => (now += ms) }
}

function hook(event: string, fields: JsonObject = {}, sessionId = 'sess-1'): HookInput {
  const input = parseHookInput({ hook_event_name: event, session_id: sessionId, cwd: 'C:\\work\\korus', permission_mode: 'default', ...fields })

  assert.ok(input)

  return input
}

test('a prompt, a tool call and a stop move the session through its states', () => {
  const { store } = makeStore({ 'C:\\work\\korus\\src\\invoice.ts': 'a\nb\nc\n' })

  store.apply(hook('UserPromptSubmit', { prompt: '고쳐줘' }))
  assert.equal(store.sessions.get('sess-1')?.status, 'thinking')
  assert.equal(store.sessions.get('sess-1')?.name, 'korus')

  store.apply(hook('PreToolUse', { tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'C:\\work\\korus\\src\\invoice.ts' } }))

  const working = store.sessions.get('sess-1')

  assert.equal(working?.status, 'working')
  assert.equal(working?.steps[0]?.title, 'invoice.ts')
  assert.equal(working?.steps[0]?.kind, 'read')
  assert.deepEqual(
    working?.steps[0]?.preview?.type === 'code' ? working.steps[0].preview.lines.map(line => line.n) : null,
    [1, 2, 3],
  )

  store.apply(hook('PostToolUse', { tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'x' }, tool_response: {} }))
  assert.equal(store.sessions.get('sess-1')?.steps[0]?.status, 'done')
  assert.equal(store.sessions.get('sess-1')?.status, 'thinking')

  const { alerts } = store.apply(hook('Stop', { last_assistant_message: '다 고쳤어요' }))

  assert.equal(store.sessions.get('sess-1')?.status, 'done')
  assert.equal(store.sessions.get('sess-1')?.message, '다 고쳤어요')
  assert.equal(alerts[0]?.type, 'done')
})

test('a session keeps the folder it started in while Claude cds around', () => {
  const { store } = makeStore()

  store.apply(hook('SessionStart', { source: 'startup' }))
  store.apply({ ...hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), cwd: 'C:\\work\\korus\\src\\deep' })
  assert.equal(store.sessions.get('sess-1')?.name, 'korus')
  assert.equal(store.sessions.get('sess-1')?.cwd, 'C:\\work\\korus')
})

test('bash output and failures land in the terminal preview', () => {
  const { store } = makeStore()

  store.apply(hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test', description: '테스트 실행' } }))
  store.apply(hook('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' }, error: 'Exit code 1\n2 failing' }))

  const step = store.sessions.get('sess-1')?.steps[0]

  assert.equal(step?.title, '테스트 실행')
  assert.equal(step?.status, 'failed')
  assert.deepEqual(step?.preview, { type: 'terminal', command: 'npm test', output: 'Exit code 1\n2 failing', failed: true })
})

test('permission requests become pending and turn into the hook answer Claude Code expects', () => {
  const { store } = makeStore()
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }]
  const { pending, alert } = store.addPending(
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: suggestions }),
  )

  assert.equal(pending.kind, 'permission')
  assert.equal(pending.detail, 'npm test')
  assert.equal(pending.canAlwaysAllow, true)
  assert.equal(alert.type, 'pending')
  assert.equal(store.sessions.get('sess-1')?.status, 'waiting')

  const decide = (behavior: Decision['behavior']): JsonObject | null =>
    store.decisionOutput(pending.id, { id: pending.id, behavior, message: null, answers: null })

  assert.deepEqual(decide('allow'), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  assert.deepEqual(decide('always'), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: suggestions } },
  })
  assert.deepEqual(decide('deny'), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The user denied this from ChoiBuddy (widget or phone).' } },
  })
})

test('questions are answered through updatedInput', () => {
  const { store } = makeStore()
  const questions = [{ question: '어느 쪽?', header: '선택', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]
  const { pending } = store.addPending(hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions } }))

  assert.equal(pending.kind, 'question')
  assert.equal(pending.questions[0]?.options.length, 2)
  assert.deepEqual(store.decisionOutput(pending.id, { id: pending.id, behavior: 'allow', message: null, answers: { '어느 쪽?': 'B' } }), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { questions, answers: { '어느 쪽?': 'B' } } },
    },
  })
})

test('answering in the terminal clears the pending request', () => {
  const { store } = makeStore()
  const { pending } = store.addPending(hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }))
  const other = store.apply(hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } }))

  assert.deepEqual(other.cleared, [])

  const result = store.apply(hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }))

  assert.deepEqual(result.cleared, [pending.id])
  assert.equal(result.alerts[0]?.type, 'resolved')
  assert.equal(result.alerts[0]?.pendingId, pending.id)
  assert.equal(store.pending.size, 0)
})

test('sessions in the same folder get told apart, ended ones expire', () => {
  const { store, tick } = makeStore()

  store.apply(hook('SessionStart', { source: 'startup' }))
  store.apply(hook('SessionStart', { source: 'startup' }, 'abcd-2'))

  const names = store.snapshot(SERVER).sessions.map(session => session.name).sort()

  assert.deepEqual(names, ['korus · abcd', 'korus · sess'])

  store.apply(hook('SessionEnd', { reason: 'exit' }))
  tick(31 * 60_000)
  assert.deepEqual(store.prune(), ['sess-1'])
})

test('edit previews show whole lines with numbers around the change', () => {
  const file = 'import x\n\nconst TVA = 0.196\n\nexport function total() {\n  return 1\n}\n'
  const preview = editPreview('a.ts', 'TVA = 0.196', 'TVA = 0.2', () => file)

  assert.deepEqual(
    preview.lines.map(line => [line.n, line.mark, line.text]),
    [
      [1, 'none', 'import x'],
      [2, 'none', ''],
      [3, 'del', 'const TVA = 0.196'],
      [3, 'add', 'const TVA = 0.2'],
      [4, 'none', ''],
      [5, 'none', 'export function total() {'],
      [6, 'none', '  return 1'],
    ],
  )
  assert.equal(preview.language, 'ts')
})

test('edit previews fall back to a plain diff when the text is not in the file', () => {
  const preview = editPreview('a.rs', 'old', 'new\nlines', () => null)

  assert.deepEqual(
    preview.lines.map(line => [line.n, line.mark]),
    [
      [null, 'del'],
      [null, 'add'],
      [null, 'add'],
    ],
  )
})

test('mod reports add up tokens and keep the latest account limits', () => {
  const { store } = makeStore()

  store.apply(hook('SessionStart', { source: 'startup' }))
  store.applyUsage({
    sessionId: 'sess-1',
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-11T18:00:00Z' }],
  })
  store.applyUsage({ sessionId: 'sess-1', step: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 } })
  store.applyUsage({ sessionId: 'sess-1', step: { model: 'claude-opus-5-5', input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } })

  const usage = store.sessions.get('sess-1')?.usage

  assert.equal(usage?.contextPercent, 25)
  assert.equal(usage?.inputTokens, 15)
  assert.equal(usage?.outputTokens, 300)
  assert.equal(usage?.cacheReadTokens, 1900)
  assert.equal(usage?.cacheWriteTokens, 90)
  assert.equal(usage?.model, 'claude-opus-5-5')
  assert.deepEqual(store.limits?.windows, [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-11T18:00:00Z' }])
})

test('prompts wait for the mod, are handed over once and leave the queue when submitted', () => {
  const { store, tick } = makeStore()

  store.apply(hook('SessionStart', { source: 'startup' }))
  assert.equal(store.queuePrompt('sess-1', '테스트 돌려줘'), 'no-mod')
  assert.equal(store.queuePrompt('nope', 'x'), 'no-session')

  store.takePrompts('sess-1')
  assert.equal(store.queuePrompt('sess-1', '테스트 돌려줘'), 'queued')
  assert.deepEqual(store.snapshot(SERVER).sessions[0]?.queued, [{ text: '테스트 돌려줘', mode: 'steer' }])
  assert.equal(store.snapshot(SERVER).sessions[0]?.canPrompt, true)
  assert.deepEqual(
    store.takePrompts('sess-1').map(item => item.text),
    ['테스트 돌려줘'],
  )
  assert.deepEqual(store.takePrompts('sess-1'), [])

  store.apply(hook('UserPromptSubmit', { prompt: '테스트 돌려줘' }))
  assert.deepEqual(store.snapshot(SERVER).sessions[0]?.queued, [])

  tick(11_000)
  assert.equal(store.snapshot(SERVER).sessions[0]?.canPrompt, false)
})

test('subagent tool calls land on their own agent, not the main step list', () => {
  const { store } = makeStore()

  store.apply(hook('UserPromptSubmit', { prompt: '조사해 줘' }))
  store.apply(hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: '로그 조사', subagent_type: 'Explore', prompt: 'x' } }))
  store.apply(hook('SubagentStart', { agent_id: 'ag-1', agent_type: 'Explore' }))
  store.apply(hook('PreToolUse', { agent_id: 'ag-1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'error' } }))
  store.apply(hook('PostToolUse', { agent_id: 'ag-1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'error' }, tool_response: { filenames: ['a.log'] } }))

  const session = store.sessions.get('sess-1')
  const agent = session?.agents[0]

  assert.deepEqual(session?.steps.map(step => step.tool), ['Agent'])
  assert.equal(agent?.type, 'Explore')
  assert.equal(agent?.description, '로그 조사')
  assert.deepEqual(agent?.steps.map(step => `${step.tool}:${step.status}`), ['Grep:done'])
  assert.equal(session?.subagents, 1)

  store.apply(hook('SubagentStop', { agent_id: 'ag-1', agent_type: 'Explore', last_assistant_message: '원인을 찾았어요' }))
  assert.equal(store.sessions.get('sess-1')?.agents[0]?.status, 'done')
  assert.equal(store.sessions.get('sess-1')?.agents[0]?.message, '원인을 찾았어요')
  assert.equal(store.sessions.get('sess-1')?.subagents, 0)

  store.apply(hook('UserPromptSubmit', { prompt: '다음' }))
  assert.deepEqual(store.sessions.get('sess-1')?.agents, [])
})

test('pictures Claude reads or gets back from a tool land in the gallery', () => {
  const { store } = makeStore()
  const dir = mkdtempSync(join(tmpdir(), 'choibuddy-img-'))
  const picture = join(dir, 'shot.png')
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  writeFileSync(picture, Buffer.from(pixel, 'base64'))
  store.apply(hook('PreToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: picture } }))
  store.apply(hook('PreToolUse', { tool_name: 'mcp__browser__screenshot', tool_use_id: 's1', tool_input: {} }))
  store.apply(
    hook('PostToolUse', {
      tool_name: 'mcp__browser__screenshot',
      tool_use_id: 's1',
      tool_input: {},
      tool_response: [{ type: 'text', text: 'ok' }, { type: 'image', data: pixel, mimeType: 'image/png' }],
    }),
  )

  const steps = store.sessions.get('sess-1')?.steps ?? []
  const summary = store.snapshot(SERVER).gallery

  assert.equal(steps[0]?.preview?.type, 'image')
  assert.equal(steps[1]?.preview?.type, 'image')
  assert.equal(summary.count, 2)
})

test('a session the mod still polls for comes back after the bridge lost it, unless Claude Code ended it', () => {
  const { store, tick } = makeStore()
  const found = { cwd: 'C:\\work\\korus', transcript: 'C:\\claude\\projects\\korus\\open-1.jsonl', at: 500 }
  let looked = 0
  const find = (): typeof found => {
    looked += 1

    return found
  }

  assert.equal(store.revive('open-1', find), true)
  store.takePrompts('open-1')

  const back = store.snapshot(SERVER).sessions[0]

  assert.equal(back?.status, 'idle')
  assert.equal(back?.cwd, 'C:\\work\\korus')
  assert.equal(back?.updatedAt, 500)
  assert.equal(back?.canPrompt, true)
  assert.equal(store.transcriptPath('open-1'), found.transcript)
  assert.equal(store.queuePrompt('open-1', '이어서 해 줘'), 'queued')

  // Known sessions are left alone without looking for a transcript.
  assert.equal(store.revive('open-1', find), false)
  assert.equal(looked, 1)
  assert.equal(store.revive('no-transcript', () => null), false)

  store.apply(hook('SessionStart', { source: 'startup' }, 'gone-1'))
  store.apply(hook('SessionEnd', { reason: 'exit' }, 'gone-1'))
  tick(31 * 60_000)
  store.takePrompts('open-1')
  assert.deepEqual(store.prune(), ['gone-1'])
  assert.equal(store.revive('gone-1', find), false)
  assert.equal(looked, 1)

  // Started again with the same id: it may come back later.
  store.apply(hook('SessionStart', { source: 'resume' }, 'gone-1'))
  assert.equal(store.sessions.get('gone-1')?.status, 'idle')
})

test('a quiet session stays while its mod polls and goes once the mod stops', () => {
  const { store, tick } = makeStore()

  store.apply(hook('SessionStart', { source: 'startup' }))

  for (let hour = 0; hour < 13; hour += 1) {
    tick(60 * 60_000)
    store.takePrompts('sess-1')
    assert.deepEqual(store.prune(), [])
  }

  tick(11_000)
  assert.deepEqual(store.prune(), ['sess-1'])
})

test('a command an idle session never answers leaves the queue as failed', () => {
  const { store, tick } = makeStore()

  store.apply(hook('SessionStart', { source: 'startup' }))
  store.takePrompts('sess-1')
  store.queueCommand('sess-1', 'reload-plugins', '')
  assert.equal(store.takeCommands('sess-1').length, 1)

  // Still waiting: not long enough yet.
  tick(30_000)
  store.takePrompts('sess-1')
  assert.equal(store.expireCommands(), false)

  // Idle the whole time and no answer: the mod could not run it.
  tick(30_000)
  store.takePrompts('sess-1')
  assert.equal(store.expireCommands(), true)

  const session = store.snapshot(SERVER).sessions[0]

  assert.deepEqual(session?.queued, [])
  assert.deepEqual(
    session?.commandLog.map(entry => [entry.command, entry.failed, entry.text]),
    [['reload-plugins', true, '']],
  )
})
