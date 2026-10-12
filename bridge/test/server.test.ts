import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { type Bridge, deviceName, safeFileName, startBridge } from '../src/server.ts'
import { arr, asObject, type JsonObject, objects, parseJsonObject, str } from '../src/json.ts'
import { withOurHooks, withoutOurHooks } from '../src/settings-hooks.ts'

const TOKEN = 'test-token-0123456789abcdefghijklmnop'

async function withBridge(holdMs: number, body: (bridge: Bridge, base: string, claudeDir: string) => Promise<void>): Promise<void> {
  const galleryDir = mkdtempSync(join(tmpdir(), 'choibuddy-gallery-'))
  const claudeDir = mkdtempSync(join(tmpdir(), 'choibuddy-claude-'))
  const uploadsDir = mkdtempSync(join(tmpdir(), 'choibuddy-uploads-'))
  const bridge = await startBridge({ config: { port: 0, token: TOKEN, pcId: 'pc-test', devices: [], trustTailnet: false, autoLanguage: null }, saveConfig: () => {}, galleryDir, uploadsDir, docBackupDir: join(claudeDir, 'backups'), claudeDir, log: () => {}, bindTailnet: false, holdMs, read: () => null })

  try {
    await body(bridge, `http://127.0.0.1:${bridge.port}`, claudeDir)
  } finally {
    await bridge.close()
  }
}

function postHook(base: string, payload: JsonObject): Promise<JsonObject | null> {
  return fetch(`${base}/hook`, { method: 'POST', body: JSON.stringify(payload) })
    .then(res => res.text())
    .then(parseJsonObject)
}

function decide(base: string, body: JsonObject): Promise<number> {
  return fetch(`${base}/api/decide`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(res => res.status)
}

// Reads server-sent events until `until` says stop.
async function readEvents(base: string, until: (events: Array<{ event: string; data: JsonObject | null }>) => boolean): Promise<Array<{ event: string; data: JsonObject | null }>> {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/events?token=${TOKEN}`, { signal: controller.signal })
  const reader = res.body?.getReader()
  const events: Array<{ event: string; data: JsonObject | null }> = []
  const decoder = new TextDecoder()
  let buffer = ''

  assert.ok(reader)

  while (!until(events)) {
    const { value, done } = await reader.read()

    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let end = buffer.indexOf('\n\n')

    while (end !== -1) {
      const block = buffer.slice(0, end)

      buffer = buffer.slice(end + 2)
      end = buffer.indexOf('\n\n')

      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]

      if (event !== undefined && data !== undefined) events.push({ event, data: parseJsonObject(data) })
    }
  }

  controller.abort()

  return events
}

const base = { session_id: 's1', cwd: 'C:\\work\\korus', permission_mode: 'default' }

test('rejects api calls without the token and hooks from browsers', async () => {
  await withBridge(5_000, async (_bridge, url) => {
    assert.equal((await fetch(`${url}/api/snapshot`)).status, 401)
    assert.equal((await fetch(`${url}/api/snapshot?token=wrong`)).status, 401)
    assert.equal((await fetch(`${url}/api/snapshot?token=${TOKEN}`)).status, 200)

    const fromPage = await fetch(`${url}/hook`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })

    assert.equal(fromPage.status, 403)
    assert.equal((await fetch(`${url}/api/health`)).status, 200)
  })
})

test('a held permission request is answered by a remote decision', async () => {
  await withBridge(5_000, async (bridge, url) => {
    await postHook(url, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' })

    const answer = postHook(url, { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })
    const pendingOf = (data: JsonObject | null): JsonObject[] => objects(arr(data, 'pending'))
    const events = await readEvents(url, seen => seen.some(e => e.event === 'snapshot' && pendingOf(e.data).length > 0))
    const last = events.findLast(e => e.event === 'snapshot')
    const id = str(pendingOf(last?.data ?? null)[0] ?? null, 'id')

    assert.equal(typeof id, 'string')
    assert.equal(bridge.store.sessions.get('s1')?.status, 'waiting')
    assert.equal(await decide(url, { id, behavior: 'deny', message: '안 돼요' }), 200)
    assert.deepEqual(await answer, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '안 돼요' } } })
    assert.equal(await decide(url, { id, behavior: 'allow' }), 404)
    assert.equal(bridge.store.pending.size, 0)
  })
})

test('an unanswered request times out with no decision so the terminal dialog stays', async () => {
  await withBridge(150, async (bridge, url) => {
    const answer = await postHook(url, { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'x' } })

    assert.deepEqual(answer, {})
    assert.equal(bridge.store.pending.size, 0)
  })
})

test('the terminal answering first releases the held hook', async () => {
  await withBridge(5_000, async (bridge, url) => {
    const answer = postHook(url, { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })

    while (bridge.store.pending.size === 0) await new Promise(resolve => setTimeout(resolve, 10))
    await postHook(url, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } })
    assert.deepEqual(await answer, {})
    assert.equal(bridge.store.pending.size, 0)
  })
})

test('settings hooks are added once and removed without touching other hooks', () => {
  const mine = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }
  const ensure = 'C:\\Users\\me\\.choibuddy\\app\\bridge\\src\\ensure.ts'
  const node = 'C:\\Users\\me\\.choibuddy\\app\\node\\node.exe'
  const once = withOurHooks(mine, 47130, ensure, node)
  const twice = withOurHooks(once, 47130, ensure, node)
  const start = objects(arr(objects(arr(once, 'SessionStart'))[0] ?? {}, 'hooks'))[0]

  assert.deepEqual(twice, once)
  // The hook names ChoiBuddy's own Node in full: no Node on the PATH needed.
  assert.equal(str(start ?? {}, 'command'), '"C:/Users/me/.choibuddy/app/node/node.exe" --no-warnings "C:/Users/me/.choibuddy/app/bridge/src/ensure.ts" --forward')
  assert.equal(Array.isArray(once.UserPromptSubmit) ? once.UserPromptSubmit.length : 0, 2)
  assert.ok(Array.isArray(once.PermissionRequest))
  assert.deepEqual(withoutOurHooks(once), mine)
})

test('a prompt from the phone reaches the mod poll, and the mod routes refuse browsers', async () => {
  await withBridge(5_000, async (_bridge, url) => {
    const post = (path: string, body: JsonObject, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

    await postHook(url, { ...base, hook_event_name: 'SessionStart', source: 'startup' })
    assert.equal((await post('/api/prompt', { sessionId: 's1', text: 'hi' }, { Authorization: `Bearer ${TOKEN}` })).status, 409)
    await post('/mod/poll', { sessionId: 's1' })
    assert.equal((await post('/api/prompt', { sessionId: 's1', text: 'hi' }, { Authorization: `Bearer ${TOKEN}` })).status, 200)
    assert.equal((await post('/api/prompt', { sessionId: 's1', text: 'hi' })).status, 401)

    const polled = parseJsonObject(await (await post('/mod/poll', { sessionId: 's1' })).text())

    assert.deepEqual(objects(arr(polled, 'prompts')).map(item => str(item, 'text')), ['hi'])
    assert.equal((await post('/mod/poll', { sessionId: 's1' }, { Origin: 'https://evil.example' })).status, 403)
  })
})

test('a session still open in Claude Code comes back when its mod polls a bridge that lost it', async () => {
  await withBridge(5_000, async (_bridge, url, claudeDir) => {
    const id = '0c0ffee0-1234-4abc-8def-0123456789ab'
    const projectDir = join(claudeDir, 'projects', 'C--work-korus')
    const authorized = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', cwd: 'C:\\work', sessionId: id, message: { role: 'user', content: 'korus로 가서 부가세율 고쳐줘' } }),
        JSON.stringify({ type: 'assistant', cwd: 'C:\\work\\korus', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: '고칠게요.' }] } }),
        '',
      ].join('\n'),
    )

    // No hook since the bridge started: the prompt has nowhere to go yet.
    assert.equal((await fetch(`${url}/api/prompt`, { method: 'POST', headers: authorized, body: JSON.stringify({ sessionId: id, text: '이어서' }) })).status, 409)

    await fetch(`${url}/mod/poll`, { method: 'POST', body: JSON.stringify({ sessionId: id }) })

    const snapshot = parseJsonObject(await (await fetch(`${url}/api/snapshot`, { headers: authorized })).text())
    const session = objects(arr(snapshot, 'sessions')).find(item => str(item, 'id') === id)

    assert.equal(str(session ?? {}, 'status'), 'idle')
    // It moved to korus after starting in C:\work; the newest folder counts.
    assert.equal(str(session ?? {}, 'cwd'), 'C:\\work\\korus')
    assert.equal((await fetch(`${url}/api/prompt`, { method: 'POST', headers: authorized, body: JSON.stringify({ sessionId: id, text: '이어서' }) })).status, 200)

    // A mod polling for a session with no transcript stays unknown.
    await fetch(`${url}/mod/poll`, { method: 'POST', body: JSON.stringify({ sessionId: 'no-such-session' }) })

    const after = parseJsonObject(await (await fetch(`${url}/api/snapshot`, { headers: authorized })).text())

    assert.equal(objects(arr(after, 'sessions')).some(item => str(item, 'id') === 'no-such-session'), false)
  })
})

test('gallery images are listed and served only with the token', async () => {
  await withBridge(5_000, async (_bridge, url) => {
    const dir = mkdtempSync(join(tmpdir(), 'choibuddy-img-'))
    const picture = join(dir, 'pic.png')
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

    writeFileSync(picture, bytes)
    await postHook(url, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: picture } })

    const listed = parseJsonObject(await (await fetch(`${url}/api/gallery?token=${TOKEN}`)).text())
    const id = str(objects(arr(listed, 'images'))[0] ?? null, 'id')

    assert.equal(typeof id, 'string')
    assert.equal((await fetch(`${url}/api/image/${id}`)).status, 401)

    const image = await fetch(`${url}/api/image/${id}?token=${TOKEN}`)

    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/)
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes)
    assert.equal((await fetch(`${url}/api/image/nope?token=${TOKEN}`)).status, 404)
  })
})

test('each device gets its own code that the owner can revoke', async () => {
  await withBridge(5_000, async (_bridge, url) => {
    const owner = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
    const created = parseJsonObject(await (await fetch(`${url}/api/devices`, { method: 'POST', headers: owner })).text())
    const id = str(created, 'id')
    const code = str(created, 'token')

    assert.ok(id !== null && code !== null && code !== TOKEN)

    const phone = { Authorization: `Bearer ${code}`, 'User-Agent': 'Mozilla/5.0 (Linux; Android 16; SM-S938N Build/BP2A) AppleWebKit' }

    assert.equal((await fetch(`${url}/api/snapshot`, { headers: phone })).status, 200)
    // A device cannot hand out codes or see the others.
    assert.equal((await fetch(`${url}/api/devices`, { headers: phone })).status, 403)

    const listed = parseJsonObject(await (await fetch(`${url}/api/devices`, { headers: owner })).text())

    assert.deepEqual(
      objects(arr(listed, 'devices')).map(device => str(device, 'name')),
      ['SM-S938N'],
    )

    assert.equal((await fetch(`${url}/api/devices/revoke`, { method: 'POST', headers: owner, body: JSON.stringify({ id }) })).status, 200)
    assert.equal((await fetch(`${url}/api/snapshot`, { headers: phone })).status, 401)
  })
})

test('device names come from the user agent', () => {
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 16; SM-S938N Build/BP2A.250605.031; wv) AppleWebKit/537.36'), 'SM-S938N')
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0'), 'Windows')
  assert.equal(deviceName(undefined), 'Device')
})

test('uploads are saved under a safe name and need the token', async () => {
  await withBridge(5_000, async (_bridge, url) => {
    const body = Buffer.from('hello from the phone')

    assert.equal((await fetch(`${url}/api/upload?name=a.txt`, { method: 'POST', body })).status, 401)

    const res = await fetch(`${url}/api/upload?name=${encodeURIComponent('../../evil:name?.txt')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
      body,
    })
    const saved = parseJsonObject(await res.text())
    const path = str(saved, 'path') ?? ''

    assert.equal(res.status, 200)
    // Separators are gone, so the file stays inside the uploads folder.
    assert.match(path, /-__\.\._evil_name_\.txt$/)
    assert.equal(readFileSync(path, 'utf8'), 'hello from the phone')
  })
})

test('file names are made safe', () => {
  assert.equal(safeFileName('사진 1.png'), '사진 1.png')
  assert.equal(safeFileName('..\\..\\x.png'), '__.._x.png')
  assert.equal(safeFileName(''), 'file')
})

test('Auto Accept approves permission requests at once but leaves questions to the person', async () => {
  await withBridge(300, async (_bridge, url) => {
    const owner = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

    assert.equal((await fetch(`${url}/api/auto-accept`, { method: 'POST', headers: owner, body: JSON.stringify({ minutes: 30 }) })).status, 200)

    const allowed = await postHook(url, { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })

    assert.deepEqual(allowed, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })

    // A question is not auto-answered: it times out with no decision here.
    const question = await postHook(url, { ...base, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [] } })

    assert.deepEqual(question, {})

    await fetch(`${url}/api/auto-accept`, { method: 'POST', headers: owner, body: JSON.stringify({ minutes: 0 }) })

    const snapshot = parseJsonObject(await (await fetch(`${url}/api/snapshot?token=${TOKEN}`)).text())

    assert.equal(asObject(snapshot?.server ?? null)?.autoAcceptUntil, 0)
  })
})

test('code being written reaches the streams as text', async () => {
  await withBridge(5_000, async (_bridge, url) => {
    const events = readEvents(url, seen => seen.some(event => event.event === 'stream'))

    await new Promise(resolve => setTimeout(resolve, 100))
    await fetch(`${url}/mod/stream`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 's1', toolUseId: 't1', tool: 'Write', json: '{"file_path":"C:\\a\\b.ts","content":"export const x = 1\nexport' }),
    })

    const stream = (await events).find(event => event.event === 'stream')?.data ?? null

    assert.equal(str(stream, 'text'), 'export const x = 1\nexport')
    assert.equal(str(stream, 'path'), 'C:\a\b.ts')
    assert.equal(str(stream, 'language'), 'ts')
  })
})
