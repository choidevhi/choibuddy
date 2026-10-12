import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { arr, bool, type JsonObject, obj, objects, parseJsonObject, str } from '../src/json.ts'
import { startBridge } from '../src/server.ts'
import { codexLine, Terminals } from '../src/terminal.ts'

const TOKEN = 'test-token-0123456789abcdefghijklmnop'

test("a terminal on the PC runs in the app: typed into, read back, closed; devices only while allowed",{ skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-term-'))
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
  })
  const url = `http://127.0.0.1:${bridge.port}`
  const as = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
  const post = async (path: string, body: JsonObject, token = TOKEN): Promise<{ status: number; json: JsonObject | null }> => {
    const res = await fetch(`${url}${path}`, { method: 'POST', headers: as(token), body: JSON.stringify(body) })

    return { status: res.status, json: parseJsonObject(await res.text()) }
  }

  try {
    const opened = await post('/api/term/open', { cwd: root, run: 'shell', cols: 100, rows: 30, title: 'test' })
    const id = str(obj(opened.json, 'terminal'), 'id') ?? ''

    assert.equal(opened.status, 200)

    // Read the output stream while typing a command into the shell.
    const stream = await fetch(`${url}/api/term/stream?id=${id}&token=${TOKEN}`)
    const reader = stream.body?.getReader()
    const decoder = new TextDecoder()
    let seen = ''

    assert.ok(reader)
    await post('/api/term/input', { id, data: 'echo choibuddy-$((40+2))\r' })

    const until = Date.now() + 15_000

    while (!seen.includes('choibuddy-42') && Date.now() < until) {
      const { value, done } = await reader.read()

      if (done) break
      seen += decoder.decode(value)
    }

    assert.ok(seen.includes('choibuddy-42'), 'the shell ran what was typed')
    assert.equal((await post('/api/term/resize', { id, cols: 120, rows: 40 })).status, 200)

    // A paired device sees nothing until the PC allows it.
    const device = parseJsonObject(await (await fetch(`${url}/api/devices`, { method: 'POST', headers: as(TOKEN) })).text())
    const deviceToken = str(device, 'token') ?? ''
    const listed = async (token: string): Promise<JsonObject | null> => parseJsonObject(await (await fetch(`${url}/api/term`, { headers: as(token) })).text())

    assert.equal((await listed(deviceToken))?.allowed, false)
    assert.equal((await post('/api/term/open', { cwd: root, run: 'shell' }, deviceToken)).status, 403)
    assert.equal((await post('/api/term/remote', { on: true }, deviceToken)).status, 403)
    assert.equal((await post('/api/term/remote', { on: true })).status, 200)
    assert.equal((await listed(deviceToken))?.allowed, true)
    assert.deepEqual(
      objects(arr(await listed(deviceToken), 'terminals')).map(term => str(term, 'id')),
      [id],
    )

    // Taking the access away again cuts off the device's open stream.
    const watched = (await fetch(`${url}/api/term/stream?id=${id}&token=${deviceToken}`)).body?.getReader()

    assert.ok(watched)
    await watched.read()
    assert.equal((await post('/api/term/remote', { on: false })).status, 200)

    let ended = false

    while (!ended) ended = (await watched.read()).done

    assert.equal((await post('/api/term/input', { id, data: 'echo no\r' }, deviceToken)).status, 403)

    await reader.cancel()
    assert.equal((await post('/api/term/close', { id })).status, 200)
    assert.deepEqual(arr(await listed(TOKEN), 'terminals'), [])
  } finally {
    await bridge.close()
  }
})

test("Codex's first prompt reaches it as one plain argument, never run by the shell", { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-term-codex-'))
  const fake = join(root, 'codex.cmd')

  writeFileSync(fake, '@echo ARGS:%*\r\n')

  const terminals = new Terminals(() => 0, () => [fake, '--no-daemon'])
  const opened = terminals.open({ cwd: root, run: 'codex', cols: 200, rows: 30, title: '', prompt: "it's ’quoted’ $(Write-Output INJECTED) ; Write-Output ALSO\nnext line" })

  assert.ok(typeof opened !== 'string')

  let seen = ''
  const followed = terminals.follow(opened.id, { data: chunk => (seen += chunk), exit: () => {} })
  const until = Date.now() + 15_000

  try {
    while (!seen.includes('ARGS:') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100))
    await new Promise(resolve => setTimeout(resolve, 500))

    const line = seen.slice(seen.indexOf('ARGS:')).split(/\r?\n/)[0] ?? ''

    assert.ok(line.includes('ARGS:--no-daemon '), line)
    assert.ok(line.includes("'quoted' $(Write-Output INJECTED) ; Write-Output ALSO next line"), line)
    assert.ok(!seen.includes('\nINJECTED') && !seen.includes('\nALSO'), 'nothing in the prompt ran')
  } finally {
    followed?.stop()
    terminals.closeAll()
  }
})

test('the line that starts Codex is quoted for the shell it is typed into', () => {
  const prompt = "it's ’quoted’ $(rm -rf ~) ; next\nline"

  assert.equal(codexLine(['C:\\Codex\\codex.exe', '--no-daemon'], '', 'win32'), 'C:\\Codex\\codex.exe --no-daemon')
  assert.equal(codexLine(['C:\\Program Files\\codex.exe'], prompt, 'win32'), "& 'C:\\Program Files\\codex.exe' 'it''s ''quoted'' $(rm -rf ~) ; next line'")
  // macOS and Linux: POSIX single quotes, where only ' itself needs care.
  assert.equal(codexLine(['/opt/homebrew/bin/codex', '--no-daemon'], prompt, 'darwin'), "/opt/homebrew/bin/codex --no-daemon 'it'\\''s ’quoted’ $(rm -rf ~) ; next line'")
  assert.equal(codexLine(['/Users/Kim Lee/bin/codex'], '', 'darwin'), "'/Users/Kim Lee/bin/codex'")
})

test('Codex opened in a terminal shows at once, takes prompts typed in, and its session takes that place', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-term-codex-session-'))
  // Stands in for Codex: echoes each line typed into it.
  const fake = join(root, 'codex.cmd')

  writeFileSync(fake, '@powershell -NoProfile -Command "while ($true) { $line = [Console]::ReadLine(); if ($line -eq $null) { break }; Write-Output (\'GOT:\' + $line) }"\r\n')

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
    codexTools: { cli: () => [fake], app: () => null, install: async () => false, command: () => true, launchArgs: () => [] },
  })
  const url = `http://127.0.0.1:${bridge.port}`
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  const post = async (path: string, body: JsonObject): Promise<number> => (await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })).status
  const sessions = async (): Promise<JsonObject[]> => objects(arr(parseJsonObject(await (await fetch(`${url}/api/snapshot`, { headers })).text()), 'sessions'))
  const hook = (payload: JsonObject): Promise<Response> => fetch(`${url}/hook`, { method: 'POST', body: JSON.stringify({ cwd: root, permission_mode: 'default', agent: 'codex', ...payload }) })

  try {
    const opened = parseJsonObject(await (await fetch(`${url}/api/term/open`, { method: 'POST', headers, body: JSON.stringify({ cwd: root, run: 'codex', cols: 120, rows: 30 }) })).text())
    const id = str(obj(opened, 'terminal'), 'id') ?? ''
    const shown = `term-${id}`
    const placed = (await sessions()).find(session => str(session, 'id') === shown)

    // Shown before Codex reports anything, ready for a prompt and a stop.
    assert.equal(str(placed ?? null, 'agent'), 'codex')
    assert.equal(bool(placed ?? null, 'canPrompt'), true)
    assert.equal(bool(placed ?? null, 'canStop'), true)

    const reader = (await fetch(`${url}/api/term/stream?id=${id}&token=${TOKEN}`)).body?.getReader()
    const decoder = new TextDecoder()
    let seen = ''

    assert.ok(reader)
    await new Promise(resolve => setTimeout(resolve, 2500))
    assert.equal(await post('/api/prompt', { sessionId: shown, text: 'hello codex' }), 200)

    const until = Date.now() + 15_000

    while (!seen.includes('GOT:hello codex') && Date.now() < until) {
      const { value, done } = await reader.read()

      if (done) break
      seen += decoder.decode(value)
    }

    assert.ok(seen.includes('GOT:hello codex'), 'the prompt was typed into the terminal')
    await reader.cancel()

    // Codex starts its session: it lands in the place shown, under its id.
    await hook({ hook_event_name: 'SessionStart', session_id: 'cx-real', source: 'startup', choibuddy_term: id })
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'cx-real', prompt: 'hello codex', choibuddy_term: id })

    const after = await sessions()

    assert.deepEqual(
      after.map(session => str(session, 'id')),
      [shown],
    )
    assert.equal(str(after[0] ?? null, 'status'), 'thinking')
    assert.equal(await post('/api/sessions/stop', { sessionId: shown }), 200)

    // The terminal closed: the session stays, typing into it does not.
    assert.equal(await post('/api/term/close', { id }), 200)
    assert.equal(bool((await sessions())[0] ?? null, 'canPrompt'), false)

    // A Codex terminal closed before Codex started leaves nothing behind.
    const second = str(obj(parseJsonObject(await (await fetch(`${url}/api/term/open`, { method: 'POST', headers, body: JSON.stringify({ cwd: root, run: 'codex' }) })).text()), 'terminal'), 'id') ?? ''

    assert.equal((await sessions()).length, 2)
    assert.equal(await post('/api/term/close', { id: second }), 200)
    assert.deepEqual(
      (await sessions()).map(session => str(session, 'id')),
      [shown],
    )
  } finally {
    await bridge.close()
  }
})
