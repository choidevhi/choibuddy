import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Gallery } from '../src/gallery.ts'
import { arr, type JsonObject, objects, parseJsonObject, str } from '../src/json.ts'
import { claimLaunchPrompt, type LaunchPrompt, pickTerminal } from '../src/launch.ts'
import { type Bridge, startBridge } from '../src/server.ts'
import { parseHookInput, parseSlash, Store } from '../src/store.ts'
import { Transcripts } from '../src/transcripts.ts'

const TOKEN = 'test-token-0123456789abcdefghijklmnop'
const SERVER = { pcId: 'pc-1', hostName: 'pc', tailnetUrl: null, version: 'test', autoAcceptUntil: 0, trustTailnet: false }

function makeStore(): Store {
  let id = 0
  const newId = (): string => `id-${++id}`

  return new Store({ read: () => null, now: () => 5_000, newId, gallery: new Gallery(mkdtempSync(join(tmpdir(), 'choibuddy-gallery-')), () => 5_000, newId) })
}

function start(store: Store, sessionId = 'sess-1', fields: JsonObject = {}): void {
  const input = parseHookInput({ hook_event_name: 'SessionStart', session_id: sessionId, cwd: 'C:\\work\\korus', ...fields })

  assert.ok(input)
  store.apply(input)
}

test('slash commands are told apart from prompts', () => {
  assert.deepEqual(parseSlash('/effort high'), { command: 'effort', args: 'high' })
  assert.deepEqual(parseSlash('  /compact  '), { command: 'compact', args: '' })
  assert.deepEqual(parseSlash('/plugin:do x\ny'), { command: 'plugin:do', args: 'x\ny' })
  assert.equal(parseSlash('no slash'), null)
  assert.equal(parseSlash('/'), null)
  assert.equal(parseSlash('/a/b path'), null)
})

test('the mod reports the model and effort for the session and each subagent', () => {
  const store = makeStore()

  start(store)
  // A subagent's request can be seen before its first hook.
  assert.equal(store.applyStep({ sessionId: 'sess-1', agentId: 'ag-1', model: 'claude-haiku-5-5', effort: null }), false)
  assert.equal(store.applyStep({ sessionId: 'sess-1', agentId: null, model: 'claude-opus-5-5', effort: 'xhigh' }), true)

  const input = parseHookInput({ hook_event_name: 'SubagentStart', session_id: 'sess-1', cwd: 'C:\\work\\korus', agent_id: 'ag-1', agent_type: 'Explore' })

  assert.ok(input)
  store.apply(input)

  const session = store.snapshot(SERVER).sessions[0]

  assert.equal(session?.usage?.model, 'claude-opus-5-5')
  assert.equal(session?.usage?.effort, 'xhigh')
  assert.equal(session?.agents[0]?.model, 'claude-haiku-5-5')
})

test('commands wait for the mod, are handed over once and leave the queue with their output', () => {
  const store = makeStore()

  start(store)
  assert.equal(store.queueCommand('sess-1', 'effort', 'high'), 'no-mod')
  store.takePrompts('sess-1')
  assert.equal(store.queueCommand('sess-1', 'effort', 'high'), 'queued')
  assert.deepEqual(store.snapshot(SERVER).sessions[0]?.queued, [{ text: '/effort high', mode: 'command' }])

  const handed = store.takeCommands('sess-1')

  assert.deepEqual(
    handed.map(item => `${item.command} ${item.args}`),
    ['effort high'],
  )
  assert.deepEqual(store.takeCommands('sess-1'), [])
  assert.equal(store.commandResult({ sessionId: 'sess-1', id: handed[0]?.id ?? '', command: 'effort', args: 'high', text: 'Effort set to high', failed: false }), true)

  const session = store.snapshot(SERVER).sessions[0]

  assert.deepEqual(session?.queued, [])
  assert.equal(session?.commandLog[0]?.text, 'Effort set to high')
})

test('a terminal is picked in order: WezTerm, Windows Terminal, cmd', () => {
  const env = { ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\LA', ComSpec: 'C:\\Windows\\cmd.exe' }

  assert.equal(pickTerminal(env, () => true).name, 'WezTerm')
  assert.deepEqual(pickTerminal(env, () => true).args('C:\\work'), ['start', '--cwd', 'C:\\work', '--', 'claude'])
  assert.equal(pickTerminal(env, path => path.endsWith('wt.exe')).name, 'Windows Terminal')
  assert.equal(pickTerminal(env, () => false).name, 'cmd')
})

test('the first prompt goes to the session that opens in that folder afterwards', () => {
  const waiting: LaunchPrompt[] = [{ cwd: 'C:\\Work\\Korus', text: '테스트 돌려줘', at: 10_000 }]

  assert.equal(claimLaunchPrompt(waiting, 'C:\\work\\other', 11_000, 12_000), null)
  // A session that started before the request is not the one it opened.
  assert.equal(claimLaunchPrompt(waiting, 'C:\\work\\korus', 2_000, 12_000), null)
  assert.equal(claimLaunchPrompt(waiting, 'C:\\work\\korus', 11_000, 12_000), '테스트 돌려줘')
  assert.equal(waiting.length, 0)

  const stale: LaunchPrompt[] = [{ cwd: 'C:\\a', text: 'x', at: 0 }]

  assert.equal(claimLaunchPrompt(stale, 'C:\\a', 1, 10 * 60_000), null)
  assert.equal(stale.length, 0)
})

test('the gallery drops entries one by one or all, deleting only its own screenshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'choibuddy-gallery-'))
  const project = mkdtempSync(join(tmpdir(), 'choibuddy-project-'))
  let id = 0
  const gallery = new Gallery(dir, () => 1_000, () => `img-${++id}`)
  const picture = join(project, 'a.png')

  writeFileSync(picture, 'png')

  const read = gallery.addFile({ sessionId: 's', sessionName: 's', tool: 'Read' }, picture)
  const shot = gallery.addCapture({ sessionId: 's', sessionName: 's', tool: 'mcp__x__shot' }, { mime: 'image/png', data: Buffer.from('png').toString('base64') })

  assert.ok(read && shot)
  assert.equal(gallery.list().length, 2)
  assert.equal(gallery.remove(read.id), true)
  assert.equal(existsSync(picture), true)
  assert.equal(gallery.list().length, 1)
  assert.equal(gallery.clear(), 1)
  assert.equal(readdirSync(join(dir, 'captures')).length, 0)
  assert.equal(gallery.remove('nope'), false)
})

test('a picture whose file was deleted is left out of the list', () => {
  const project = mkdtempSync(join(tmpdir(), 'choibuddy-project-'))
  const gallery = new Gallery(mkdtempSync(join(tmpdir(), 'choibuddy-gallery-')), () => 1_000, () => 'img-1')
  const picture = join(project, 'gone.png')

  writeFileSync(picture, 'png')
  gallery.addFile({ sessionId: 's', sessionName: 's', tool: 'Read' }, picture)
  assert.equal(gallery.list().length, 1)
  unlinkSync(picture)
  assert.equal(gallery.list().length, 0)
})

test('a deleted conversation moves to the trash with its subagents', () => {
  const projects = mkdtempSync(join(tmpdir(), 'choibuddy-projects-'))
  const trash = mkdtempSync(join(tmpdir(), 'choibuddy-trash-'))
  const dir = join(projects, 'C--work-korus')

  mkdirSync(join(dir, 'sess-9', 'subagents'), { recursive: true })
  writeFileSync(join(dir, 'sess-9.jsonl'), '{}\n')
  writeFileSync(join(dir, 'sess-9', 'subagents', 'agent-1.jsonl'), '{}\n')

  const transcripts = new Transcripts(projects)

  assert.equal(transcripts.trash('sess-9', trash, Date.parse('2026-10-11T10:00:00Z')), true)
  assert.equal(existsSync(join(dir, 'sess-9.jsonl')), false)
  assert.equal(existsSync(join(dir, 'sess-9')), false)

  const [moved] = readdirSync(trash)

  assert.ok(moved !== undefined && moved.endsWith('sess-9'))
  assert.deepEqual(readdirSync(join(trash, moved)).sort(), ['sess-9', 'sess-9.jsonl'])
  assert.equal(transcripts.trash('sess-9', trash, 0), false)
})

async function withBridge(body: (bridge: Bridge, base: string, claudeDir: string) => Promise<void>): Promise<void> {
  const claudeDir = mkdtempSync(join(tmpdir(), 'choibuddy-claude-'))
  const uploadsDir = mkdtempSync(join(tmpdir(), 'choibuddy-uploads-'))
  const bridge = await startBridge({
    config: { port: 0, token: TOKEN, pcId: 'pc-test', devices: [], trustTailnet: false },
    saveConfig: () => {},
    galleryDir: mkdtempSync(join(tmpdir(), 'choibuddy-gallery-')),
    uploadsDir,
    docBackupDir: join(claudeDir, 'backups'),
    trashDir: join(claudeDir, 'trash'),
    claudeDir,
    log: () => {},
    bindTailnet: false,
    holdMs: 5_000,
    read: () => null,
  })

  try {
    await body(bridge, `http://127.0.0.1:${bridge.port}`, claudeDir)
  } finally {
    await bridge.close()
  }
}

function post(url: string, path: string, body: JsonObject, auth = true): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (auth) headers.Authorization = `Bearer ${TOKEN}`

  return fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

test('a slash command the session offers runs as a command; anything else stays a prompt', async () => {
  await withBridge(async (_bridge, url) => {
    await post(url, '/hook', { hook_event_name: 'SessionStart', session_id: 's1', cwd: 'C:\\work' }, false)
    await post(url, '/mod/poll', { sessionId: 's1' }, false)
    await post(url, '/mod/commands', { sessionId: 's1', commands: [{ name: 'effort', description: 'Set effort', source: 'builtin' }, { x: 1 }] }, false)

    const listed = parseJsonObject(await (await fetch(`${url}/api/commands?session=s1&token=${TOKEN}`)).text())

    assert.deepEqual(objects(arr(listed, 'commands')).map(item => str(item, 'name')), ['effort'])
    assert.equal((await post(url, '/api/prompt', { sessionId: 's1', text: '/effort max' })).status, 200)
    assert.equal((await post(url, '/api/prompt', { sessionId: 's1', text: '/usr/bin is where it lives' })).status, 200)

    const polled = parseJsonObject(await (await post(url, '/mod/poll', { sessionId: 's1' }, false)).text())

    assert.deepEqual(objects(arr(polled, 'commands')).map(item => `${str(item, 'command')} ${str(item, 'args')}`), ['effort max'])
    assert.deepEqual(objects(arr(polled, 'prompts')).map(item => str(item, 'text')), ['/usr/bin is where it lives'])
  })
})

test('Claude asks the widget for its browser and gets the page, a screenshot path and the picked element', async () => {
  await withBridge(async (_bridge, url) => {
    const controller = new AbortController()
    const events = await fetch(`${url}/api/events?token=${TOKEN}`, { signal: controller.signal })
    const reader = events.body?.getReader()

    assert.ok(reader)

    const asked = post(url, '/mod/browser-view', { sessionId: 's1' }, false).then(res => res.text())
    const decoder = new TextDecoder()
    let buffer = ''
    let requestId: string | null = null

    while (requestId === null) {
      const { value, done } = await reader.read()

      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const data = /event: browser-request\ndata: (.*)\n/.exec(buffer)?.[1]

      requestId = data === undefined ? null : str(parseJsonObject(data), 'id')
    }

    controller.abort()
    assert.ok(requestId)

    const answered = await post(url, '/api/browser/answer', {
      id: requestId,
      ok: true,
      url: 'http://localhost:5173/',
      title: 'Shop',
      picked: 'button.buy',
      image: Buffer.from('png').toString('base64'),
    })

    assert.equal(answered.status, 200)

    const reply = parseJsonObject(await asked)

    assert.equal(str(reply, 'url'), 'http://localhost:5173/')
    assert.equal(str(reply, 'picked'), 'button.buy')
    assert.ok(existsSync(str(reply, 'imagePath') ?? ''))
  })
})

test('a live conversation cannot be deleted, a missing folder cannot be opened', async () => {
  await withBridge(async (_bridge, url) => {
    await post(url, '/hook', { hook_event_name: 'SessionStart', session_id: 's1', cwd: 'C:\\work' }, false)
    assert.equal((await post(url, '/api/conversation/delete', { sessionId: 's1' })).status, 409)
    assert.equal((await post(url, '/api/conversation/delete', { sessionId: 'unknown' })).status, 404)
    assert.equal((await post(url, '/api/session/new', { cwd: join(tmpdir(), 'choibuddy-no-such-folder-xyz') })).status, 400)
    assert.equal((await post(url, '/api/session/new', { cwd: 'C:\\' }, false)).status, 401)
  })
})

test('a conversation read from a fixed start keeps its old messages as new ones arrive', () => {
  const projects = mkdtempSync(join(tmpdir(), 'choibuddy-projects-'))
  const dir = join(projects, 'C--work')
  const file = join(dir, 'sess-7.jsonl')
  const said = (role: 'user' | 'assistant', text: string, index: number): string =>
    `${JSON.stringify(role === 'user' ? { type: 'user', uuid: `u${index}`, message: { role, content: text } } : { type: 'assistant', uuid: `a${index}`, message: { id: `m${index}`, role, content: [{ type: 'text', text }] } })}\n`

  mkdirSync(dir, { recursive: true })
  writeFileSync(file, [0, 1, 2, 3, 4, 5].map(index => said(index % 2 === 0 ? 'user' : 'assistant', `message ${index}`, index)).join(''))

  const transcripts = new Transcripts(projects)
  const first = transcripts.conversation('sess-7', file, null, 4)

  assert.equal(first.start, 2)
  writeFileSync(file, `${said('user', 'message 6', 6)}${said('assistant', 'message 7', 7)}`, { flag: 'a' })

  const later = transcripts.conversation('sess-7', file, null, 4, first.start)

  assert.equal(later.start, 2)
  assert.deepEqual(
    later.messages.map(message => message.text),
    ['message 2', 'message 3', 'message 4', 'message 5', 'message 6', 'message 7'],
  )
})

test('compaction shows as a note and task notifications are not shown as typed text', () => {
  const projects = mkdtempSync(join(tmpdir(), 'choibuddy-projects-'))
  const dir = join(projects, 'C--work')
  const file = join(dir, 'sess-8.jsonl')

  mkdirSync(dir, { recursive: true })
  writeFileSync(
    file,
    [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix it' } },
      { type: 'system', subtype: 'compact_boundary', uuid: 's1' },
      { type: 'user', uuid: 'u2', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation...' } },
      { type: 'user', uuid: 'u3', message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>' } },
      { type: 'user', uuid: 'u4', message: { role: 'user', content: 'and now?' } },
    ]
      .map(line => `${JSON.stringify(line)}\n`)
      .join(''),
  )

  const messages = new Transcripts(projects).conversation('sess-8', file, null, 50).messages

  assert.deepEqual(
    messages.map(message => `${message.role}:${message.text}`),
    ['user:fix it', 'note:compacted', 'user:and now?'],
  )
})

test('prompts keep how they should meet a running turn, and steered ones leave the queue', () => {
  const store = makeStore()

  start(store)
  store.takePrompts('sess-1')
  store.queuePrompt('sess-1', '색을 파랑으로', 'steer')
  store.queuePrompt('sess-1', '끝나면 커밋해', 'queue')

  const handed = store.takePrompts('sess-1')

  assert.deepEqual(
    handed.map(item => `${item.mode}:${item.text}`),
    ['steer:색을 파랑으로', 'queue:끝나면 커밋해'],
  )
  assert.equal(store.steered('sess-1', [handed[0]?.id ?? '']), true)
  assert.deepEqual(store.snapshot(SERVER).sessions[0]?.queued, [{ text: '끝나면 커밋해', mode: 'queue' }])
  assert.equal(store.steered('sess-1', ['unknown']), false)
})
