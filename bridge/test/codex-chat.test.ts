import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { patchText } from '../src/codex-chat.ts'
import { arr, type JsonObject, obj, objects, parseJsonObject, str } from '../src/json.ts'
import { startBridge } from '../src/server.ts'

const TOKEN = 'test-token-0123456789abcdefghijklmnop'

test('a Codex file change reads as an apply_patch text', () => {
  assert.equal(
    patchText([
      { path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new' },
      { path: 'b.md', kind: { type: 'add' }, diff: '+hello' },
    ]),
    '*** Begin Patch\n*** Update File: src/a.ts\n@@ -1 +1 @@\n-old\n+new\n*** Add File: b.md\n+hello\n*** End Patch',
  )
})

test('Codex run by ChoiBuddy: started from New session, model and effort set here, replies, approvals, send now and stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-codex-chat-'))
  const logFile = join(root, 'app-server.log')
  const bridge = await startBridge({
    config: { port: 0, token: TOKEN, pcId: 'pc-self', devices: [], trustTailnet: false, autoLanguage: null, remoteTerminal: false },
    saveConfig: () => {},
    galleryDir: join(root, 'gallery'),
    uploadsDir: join(root, 'uploads'),
    docBackupDir: join(root, 'backups'),
    claudeDir: join(root, 'claude'),
    log: () => {},
    bindTailnet: false,
    read: () => null,
    modManifest: join(root, 'no-mod.json'),
    codexHome: join(root, 'codex'),
    codexTools: {
      cli: () => [process.execPath, '--no-warnings', join(import.meta.dirname, 'fake-codex-chat.ts'), logFile],
      app: () => null,
      install: async () => false,
      command: () => true,
      launchArgs: () => [],
    },
  })
  const url = `http://127.0.0.1:${bridge.port}`
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  const post = async (path: string, body: JsonObject): Promise<{ status: number; json: JsonObject | null }> => {
    const res = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })

    return { status: res.status, json: parseJsonObject(await res.text()) }
  }
  const snapshot = async (): Promise<JsonObject | null> => parseJsonObject(await (await fetch(`${url}/api/snapshot`, { headers })).text())
  const session = async (): Promise<JsonObject | null> => objects(arr(await snapshot(), 'sessions'))[0] ?? null
  const until = async (test: (current: JsonObject | null) => boolean): Promise<JsonObject | null> => {
    const end = Date.now() + 10_000

    while (Date.now() < end) {
      const current = await snapshot()

      if (test(current)) return current
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    return null
  }
  const sent = (): JsonObject[] =>
    readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .flatMap((line): JsonObject[] => {
        const parsed = parseJsonObject(line)

        return parsed === null ? [] : [parsed]
      })
  const turnsStarted = (): JsonObject[] => sent().filter(message => str(message, 'method') === 'turn/start')

  try {
    const opened = await post('/api/session/new', { cwd: root, agent: 'codex', prompt: '' })
    const id = str(opened.json, 'sessionId') ?? ''

    assert.equal(opened.status, 200)
    assert.equal(id, 'th-1')

    const first = await session()

    assert.equal(str(first, 'agent'), 'codex')
    assert.equal(first?.managed, true)
    assert.equal(first?.canPrompt, true)
    assert.equal(str(obj(first, 'usage'), 'model'), 'gpt-test')

    // The Codex account's windows came with the start.
    assert.ok(await until(current => objects(arr(obj(current, 'codexLimits'), 'windows')).length === 2))

    // Models to pick from, and the pick for the next turn.
    const models = parseJsonObject(await (await fetch(`${url}/api/codex/models`, { headers })).text())

    assert.deepEqual(
      objects(arr(models, 'models')).map(model => [str(model, 'id'), arr(model, 'efforts')]),
      [['gpt-test', ['low', 'high']]],
    )
    assert.equal((await post('/api/codex/settings', { sessionId: id, model: 'gpt-test', effort: 'high' })).status, 200)
    assert.equal(str(obj(await session(), 'usage'), 'effort'), 'high')

    // A prompt: a turn with that effort, the reply on the session.
    assert.equal((await post('/api/prompt', { sessionId: id, text: '안녕?' })).status, 200)
    assert.ok(await until(current => str(objects(arr(current, 'sessions'))[0] ?? null, 'message') === '안녕하세요'))
    assert.equal(str(obj(turnsStarted()[0] ?? null, 'params'), 'effort'), 'high')
    assert.equal(str(await session(), 'prompt'), '안녕?')

    // A command Codex asks to run waits for the person, then runs.
    assert.equal((await post('/api/prompt', { sessionId: id, text: 'run it' })).status, 200)

    const asking = await until(current => objects(arr(current, 'pending')).length === 1)
    const pending = objects(arr(asking, 'pending'))[0] ?? null

    assert.equal(pending?.canAlwaysAllow, true)
    assert.equal((await post('/api/decide', { id: str(pending, 'id') ?? '', behavior: 'allow' })).status, 200)

    const ran = await until(current => {
      const steps = objects(arr(objects(arr(current, 'sessions'))[0] ?? null, 'steps'))

      return steps.some(step => str(step, 'tool') === 'Bash' && str(step, 'status') === 'done')
    })
    const decided = (requestId: number): string | null =>
      str(obj(sent().find(message => message.id === requestId && obj(message, 'result') !== null) ?? null, 'result'), 'decision')

    assert.ok(ran, 'the command ran after it was allowed')
    assert.equal(decided(100), 'accept')

    // "Always allow" is Codex's accept for the session.
    assert.equal((await post('/api/prompt', { sessionId: id, text: 'run it again' })).status, 200)

    const askingAgain = await until(current => objects(arr(current, 'pending')).length === 1)

    assert.equal((await post('/api/decide', { id: str(objects(arr(askingAgain, 'pending'))[0] ?? null, 'id') ?? '', behavior: 'always' })).status, 200)
    assert.ok(await until(() => decided(101) !== null))
    assert.equal(decided(101), 'acceptForSession')

    // Sent now while it works: the turn stops and the message goes next.
    await until(current => str(objects(arr(current, 'sessions'))[0] ?? null, 'status') !== 'thinking')
    assert.equal((await post('/api/prompt', { sessionId: id, text: 'slow job' })).status, 200)
    await until(() => turnsStarted().length === 4)
    assert.equal((await post('/api/prompt', { sessionId: id, text: '그거 말고 이거' })).status, 200)
    assert.ok(await until(() => turnsStarted().length === 5))
    assert.ok(sent().some(message => str(message, 'method') === 'turn/interrupt'))
    assert.equal(objects(arr(obj(turnsStarted()[4] ?? null, 'params'), 'input')).map(item => str(item, 'text')).join(''), '그거 말고 이거')

    // Stop while it works ends the turn; idle, there is nothing to stop.
    assert.equal((await post('/api/prompt', { sessionId: id, text: 'slow again' })).status, 200)
    await until(() => turnsStarted().length === 6)
    assert.equal((await post('/api/sessions/stop', { sessionId: id })).status, 200)
    assert.ok(await until(current => str(objects(arr(current, 'sessions'))[0] ?? null, 'status') !== 'thinking'))
    assert.equal((await post('/api/sessions/stop', { sessionId: id })).status, 409)

    // Ending it from the session menu lets Codex go; nothing more goes in.
    assert.equal((await post('/api/sessions/end', { sessionId: id })).status, 200)
    assert.ok(await until(current => str(objects(arr(current, 'sessions'))[0] ?? null, 'status') === 'ended'))
    assert.ok(sent().some(message => str(message, 'method') === 'thread/unsubscribe'))
    assert.equal((await post('/api/prompt', { sessionId: id, text: '또?' })).status, 409)
  } finally {
    await bridge.close()
  }
})

test('Codex run by ChoiBuddy: its commands, plan, questions, permissions, MCP forms and pictures sent along', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-codex-more-'))
  const logFile = join(root, 'app-server.log')
  const bridge = await startBridge({
    config: { port: 0, token: TOKEN, pcId: 'pc-self', devices: [], trustTailnet: false, autoLanguage: null, remoteTerminal: false },
    saveConfig: () => {},
    galleryDir: join(root, 'gallery'),
    uploadsDir: join(root, 'uploads'),
    docBackupDir: join(root, 'backups'),
    claudeDir: join(root, 'claude'),
    log: () => {},
    bindTailnet: false,
    read: () => null,
    modManifest: join(root, 'no-mod.json'),
    codexHome: join(root, 'codex'),
    codexTools: {
      cli: () => [process.execPath, '--no-warnings', join(import.meta.dirname, 'fake-codex-chat.ts'), logFile],
      app: () => null,
      install: async () => false,
      command: () => true,
      launchArgs: () => [],
    },
  })
  const url = `http://127.0.0.1:${bridge.port}`
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  const post = async (path: string, body: JsonObject): Promise<number> => (await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })).status
  const snapshot = async (): Promise<JsonObject | null> => parseJsonObject(await (await fetch(`${url}/api/snapshot`, { headers })).text())
  const until = async (test: (current: JsonObject | null) => boolean): Promise<JsonObject | null> => {
    const end = Date.now() + 10_000

    while (Date.now() < end) {
      const current = await snapshot()

      if (test(current)) return current
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    return null
  }
  const sent = (): JsonObject[] =>
    readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .flatMap((line): JsonObject[] => {
        const parsed = parseJsonObject(line)

        return parsed === null ? [] : [parsed]
      })
  const answerTo = (requestId: number): JsonObject | null => obj(sent().find(message => message.id === requestId && obj(message, 'result') !== null) ?? null, 'result')
  const idle = (current: JsonObject | null): boolean => str(objects(arr(current, 'sessions'))[0] ?? null, 'status') !== 'thinking'
  const asking = async (): Promise<JsonObject | null> => objects(arr(await until(current => objects(arr(current, 'pending')).length === 1), 'pending'))[0] ?? null

  try {
    assert.equal(await post('/api/session/new', { cwd: root, agent: 'codex', prompt: '' }), 200)

    // Codex's own commands, not Claude's, in the "/" list.
    assert.equal(objects(arr(await snapshot(), 'sessions'))[0]?.canCommand, true)

    const commands = parseJsonObject(await (await fetch(`${url}/api/commands?session=th-1`, { headers })).text())

    assert.deepEqual(
      objects(arr(commands, 'commands')).map(command => str(command, 'name')),
      ['compact', 'review'],
    )

    // A picture sent along goes to Codex as an image, not only as its path.
    const uploaded = parseJsonObject(await (await fetch(`${url}/api/upload?session=th-1&name=shot.png`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: new Uint8Array([137, 80, 78, 71]) })).text())
    const picture = str(uploaded, 'path') ?? ''

    assert.equal(await post('/api/prompt', { sessionId: 'th-1', text: `이 그림 봐줘 ${picture}` }), 200)
    assert.deepEqual(
      objects(arr(obj(sent().find(message => str(message, 'method') === 'turn/start') ?? null, 'params'), 'input')).map(item => [str(item, 'type'), str(item, 'path')]),
      [
        ['text', null],
        ['localImage', picture],
      ],
    )

    // The plan shows as the session's todo list.
    await until(idle)
    assert.equal(await post('/api/prompt', { sessionId: 'th-1', text: 'make a plan' }), 200)

    const planned = await until(current => objects(arr(objects(arr(current, 'sessions'))[0] ?? null, 'todos')).length === 3)

    assert.deepEqual(
      objects(arr(objects(arr(planned, 'sessions'))[0] ?? null, 'todos')).map(todo => [str(todo, 'content'), str(todo, 'status')]),
      [
        ['Read the code', 'completed'],
        ['Fix the bug', 'in_progress'],
        ['Test it', 'pending'],
      ],
    )

    // A question with its options, answered back by question id.
    await until(idle)
    assert.equal(await post('/api/prompt', { sessionId: 'th-1', text: 'ask me' }), 200)

    const question = await asking()

    assert.equal(str(question, 'kind'), 'question')
    assert.equal(str(question, 'agent'), 'codex')
    assert.deepEqual(
      objects(arr(objects(arr(question, 'questions'))[0] ?? null, 'options')).map(option => str(option, 'label')),
      ['Red', 'Blue'],
    )
    assert.equal(await post('/api/decide', { id: str(question, 'id') ?? '', behavior: 'allow', answers: { 'Which color?': 'Blue' } }), 200)
    assert.deepEqual(answerTo(100), { answers: { color: { answers: ['Blue'] } } })

    // More than its sandbox allows: what it asks for, granted for the session.
    await until(idle)
    assert.equal(await post('/api/prompt', { sessionId: 'th-1', text: 'net please' }), 200)

    const permission = await asking()

    assert.equal(str(permission, 'tool'), 'Permissions')
    assert.equal(str(permission, 'detail'), 'to fetch the docs — network')
    assert.equal(permission?.canAlwaysAllow, true)
    assert.equal(await post('/api/decide', { id: str(permission, 'id') ?? '', behavior: 'always' }), 200)
    assert.deepEqual(answerTo(101), { permissions: { network: { enabled: true } }, scope: 'session' })

    // An MCP server's form is declined, so the turn goes on.
    await until(idle)
    assert.equal(await post('/api/prompt', { sessionId: 'th-1', text: 'form' }), 200)
    assert.ok(await until(() => answerTo(102) !== null))
    assert.deepEqual(answerTo(102), { action: 'decline', content: null, _meta: null })

    // /compact and /review run as Codex's own, each as a turn of the session.
    await until(idle)
    assert.equal(await post('/api/prompt', { sessionId: 'th-1', text: '/compact' }), 200)
    assert.ok(sent().some(message => str(message, 'method') === 'thread/compact/start'))
    assert.ok(await until(current => idle(current) && str(objects(arr(current, 'sessions'))[0] ?? null, 'prompt') === '/compact'))
    assert.equal(await post('/api/prompt', { sessionId: 'th-1', text: '/review the auth code' }), 200)
    assert.deepEqual(obj(obj(sent().find(message => str(message, 'method') === 'review/start') ?? null, 'params'), 'target'), { type: 'custom', instructions: 'the auth code' })
    assert.ok(await until(current => idle(current) && str(objects(arr(current, 'sessions'))[0] ?? null, 'prompt') === '/review the auth code'))
  } finally {
    await bridge.close()
  }
})

test('Codex run by ChoiBuddy is back after the bridge restarts, and resumed in Codex when a message goes to it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-codex-kept-'))
  const logFile = join(root, 'app-server.log')
  const start = () =>
    startBridge({
      config: { port: 0, token: TOKEN, pcId: 'pc-self', devices: [], trustTailnet: false, autoLanguage: null, remoteTerminal: false },
      saveConfig: () => {},
      galleryDir: join(root, 'gallery'),
      uploadsDir: join(root, 'uploads'),
      docBackupDir: join(root, 'backups'),
      claudeDir: join(root, 'claude'),
      log: () => {},
      bindTailnet: false,
      read: () => null,
      modManifest: join(root, 'no-mod.json'),
      codexHome: join(root, 'codex'),
      codexTools: {
        cli: () => [process.execPath, '--no-warnings', join(import.meta.dirname, 'fake-codex-chat.ts'), logFile],
        app: () => null,
        install: async () => false,
        command: () => true,
        launchArgs: () => [],
      },
    })
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  const methods = (): string[] =>
    readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .flatMap(line => str(parseJsonObject(line), 'method') ?? [])

  const first = await start()

  try {
    const res = await fetch(`http://127.0.0.1:${first.port}/api/session/new`, { method: 'POST', headers, body: JSON.stringify({ cwd: root, agent: 'codex', prompt: '' }) })

    assert.equal(res.status, 200)
  } finally {
    await first.close()
  }

  const second = await start()
  const url = `http://127.0.0.1:${second.port}`

  try {
    const back = objects(arr(parseJsonObject(await (await fetch(`${url}/api/snapshot`, { headers })).text()), 'sessions'))[0] ?? null

    assert.equal(str(back, 'id'), 'th-1')
    assert.equal(back?.managed, true)
    assert.equal(str(back, 'status'), 'idle')

    const sent = await fetch(`${url}/api/prompt`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'th-1', text: '이어서 해줘' }) })

    assert.equal(sent.status, 200)

    const after = methods()

    assert.ok(after.lastIndexOf('thread/resume') !== -1 && after.lastIndexOf('thread/resume') < after.lastIndexOf('turn/start'), 'resumed before the turn')
  } finally {
    await second.close()
  }
})
