import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Config } from '../src/config.ts'
import { arr, bool, type JsonObject, obj, objects, parseJsonObject, str } from '../src/json.ts'
import { SessionMeta } from '../src/meta.ts'
import { type BridgeHealth, startBridge } from '../src/server.ts'
import { ownDevice, parseStatus, plainIp, Tailnet } from '../src/tailnet.ts'

const TOKEN = 'test-token-0123456789abcdefghijklmnop'

// A tailnet as `tailscale status --json` reports it: this PC (user 7), a phone
// and a PC of the same account, someone else's PC, a shared-in node and a tagged server.
const STATUS = {
  Self: { HostName: 'STUDIO-PC', UserID: 7, TailscaleIPs: ['100.88.0.1', 'fd7a::1'] },
  Peer: {
    a: { HostName: 'pixel', OS: 'android', UserID: 7, Online: true, TailscaleIPs: ['100.88.0.2'] },
    b: { HostName: 'laptop', OS: 'windows', UserID: 7, Online: true, TailscaleIPs: ['100.88.0.3'] },
    c: { HostName: 'friend-pc', OS: 'windows', UserID: 9, Online: true, TailscaleIPs: ['100.88.0.4'] },
    d: { HostName: 'shared', OS: 'linux', UserID: 7, Online: true, ShareeNode: true, TailscaleIPs: ['100.88.0.5'] },
    e: { HostName: 'server', OS: 'linux', UserID: 7, Online: true, Tags: ['tag:prod'], TailscaleIPs: ['100.88.0.6'] },
    f: { HostName: 'old-pc', OS: 'windows', UserID: 7, Online: false, TailscaleIPs: ['100.88.0.7'] },
  },
}

test('only devices of the same Tailscale account count as the person own', () => {
  const view = parseStatus(STATUS)

  assert.equal(ownDevice(view, '100.88.0.2'), 'pixel')
  assert.equal(ownDevice(view, '100.88.0.3'), 'laptop')
  assert.equal(ownDevice(view, '100.88.0.1'), 'self')
  assert.equal(ownDevice(view, '100.88.0.4'), null)
  assert.equal(ownDevice(view, '100.88.0.5'), null)
  assert.equal(ownDevice(view, '100.88.0.6'), null)
  assert.equal(ownDevice(view, '100.99.9.9'), null)
  assert.equal(plainIp('::ffff:100.88.0.2'), '100.88.0.2')
  // Without Tailscale (or signed out) nothing is anyone's.
  assert.equal(ownDevice(parseStatus(null), '100.88.0.2'), null)
})

test('names and the archive survive a restart, and a deleted session takes them along', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'choibuddy-meta-')), 'sessions.json')
  const meta = new SessionMeta(path)

  assert.equal(meta.rename('s1', '  위젯   작업 '), '위젯 작업')
  assert.equal(meta.setArchived(['s2', 's3'], true), 2)
  assert.equal(meta.setArchived(['s2'], true), 0)

  const again = new SessionMeta(path)

  assert.equal(again.name('s1'), '위젯 작업')
  assert.equal(again.archived('s2'), true)
  assert.equal(again.rename('s1', ''), null)
  again.forget('s2')
  assert.equal(new SessionMeta(path).name('s1'), null)
  assert.equal(new SessionMeta(path).archived('s2'), false)
  assert.equal(new SessionMeta(path).archived('s3'), true)
})

type Setup = { url: string; claudeDir: string; config: Config; probed: string[] }

async function withBridge(health: Record<string, BridgeHealth>, body: (setup: Setup) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-sessions-'))
  const claudeDir = join(root, 'claude')
  const config: Config = { port: 0, token: TOKEN, pcId: 'pc-self', devices: [], trustTailnet: false }
  const probed: string[] = []
  const bridge = await startBridge({
    config,
    saveConfig: () => {},
    galleryDir: join(root, 'gallery'),
    uploadsDir: join(root, 'uploads'),
    docBackupDir: join(root, 'backups'),
    claudeDir,
    log: () => {},
    bindTailnet: false,
    read: () => null,
    tailscale: new Tailnet(() => Promise.resolve(JSON.stringify(STATUS)), Date.now),
    probe: baseUrl => {
      probed.push(baseUrl)

      return Promise.resolve(health[baseUrl] ?? null)
    },
  })

  try {
    await body({ url: `http://127.0.0.1:${bridge.port}`, claudeDir, config, probed })
  } finally {
    await bridge.close()
  }
}

const authorized = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

async function api(url: string, path: string, body?: JsonObject, headers: Record<string, string> = authorized): Promise<{ status: number; json: JsonObject | null }> {
  const res = await fetch(`${url}${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) })

  return { status: res.status, json: parseJsonObject(await res.text()) }
}

function hook(url: string, payload: JsonObject): Promise<Response> {
  return fetch(`${url}/hook`, { method: 'POST', body: JSON.stringify({ cwd: 'C:/work/korus', permission_mode: 'default', ...payload }) })
}

function transcript(claudeDir: string, sessionId: string, title: string): void {
  const dir = join(claudeDir, 'projects', 'C--work-korus')

  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId })}\n${JSON.stringify({ type: 'user', cwd: 'C:/work/korus', sessionId, message: { role: 'user', content: 'hi' } })}\n`)
}

test('a renamed session keeps its name in the list, the snapshot and its approval requests', async () => {
  await withBridge({}, async ({ url, claudeDir }) => {
    transcript(claudeDir, 'live-1', 'Fix VAT')
    await hook(url, { hook_event_name: 'SessionStart', session_id: 'live-1', source: 'startup' })

    assert.equal((await api(url, '/api/sessions/rename', { sessionId: 'live-1', title: '부가세 작업' })).status, 200)

    const history = objects(arr((await api(url, '/api/history')).json, 'sessions'))
    const snapshot = (await api(url, '/api/snapshot')).json

    assert.equal(str(history.find(entry => str(entry, 'sessionId') === 'live-1') ?? {}, 'title'), '부가세 작업')
    assert.equal(str(objects(arr(snapshot, 'sessions'))[0] ?? {}, 'name'), '부가세 작업')

    void hook(url, { hook_event_name: 'PermissionRequest', session_id: 'live-1', tool_name: 'Bash', tool_input: { command: 'ls' } })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(str(objects(arr((await api(url, '/api/snapshot')).json, 'pending'))[0] ?? {}, 'sessionName'), '부가세 작업')
  })
})

test('ended sessions are archived and brought back; open ones stay in the list', async () => {
  await withBridge({}, async ({ url, claudeDir }) => {
    transcript(claudeDir, 'old-1', 'Old work')
    transcript(claudeDir, 'live-1', 'Still going')
    await hook(url, { hook_event_name: 'SessionStart', session_id: 'live-1', source: 'startup' })

    const flags = async (): Promise<Map<string, boolean | null>> =>
      new Map(objects(arr((await api(url, '/api/history')).json, 'sessions')).map(entry => [str(entry, 'sessionId') ?? '', bool(entry, 'archived')]))
    const archived = await api(url, '/api/sessions/archive', { sessionIds: ['old-1', 'live-1'], archived: true })

    assert.equal(archived.json?.changed, 1)
    assert.equal((await flags()).get('old-1'), true)
    assert.equal((await flags()).get('live-1'), false)

    await api(url, '/api/sessions/archive', { sessionIds: ['old-1'], archived: false })
    assert.equal((await flags()).get('old-1'), false)
  })
})

test('ending a session sends /exit through the mod, and the mod is asked for lost commands', async () => {
  await withBridge({}, async ({ url }) => {
    await hook(url, { hook_event_name: 'SessionStart', session_id: 'live-1', source: 'startup' })

    // No mod polling yet: nothing can close it.
    assert.equal((await api(url, '/api/sessions/end', { sessionId: 'live-1' })).status, 409)
    assert.equal((await api(url, '/api/sessions/end', { sessionId: 'nope' })).status, 404)

    const first = (await api(url, '/mod/poll', { sessionId: 'live-1' }, {})).json

    assert.equal(bool(first, 'needCommands'), true)
    await api(url, '/mod/commands', { sessionId: 'live-1', commands: [{ name: 'exit', description: 'Exit', source: 'builtin' }] }, {})
    assert.equal((await api(url, '/api/sessions/end', { sessionId: 'live-1' })).status, 200)

    const polled = (await api(url, '/mod/poll', { sessionId: 'live-1' }, {})).json

    assert.deepEqual(objects(arr(polled, 'commands')).map(command => str(command, 'command')), ['exit'])
    assert.equal(bool(polled, 'needCommands'), false)
  })
})

test('other PCs of the same account with a bridge are found; phones, strangers and this PC are not', async () => {
  const health = {
    'http://100.88.0.3:47130': { pcId: 'pc-laptop', version: '0.5.9', trustTailnet: true },
    'http://100.88.0.4:47130': { pcId: 'pc-friend', version: '0.5.9', trustTailnet: true },
    'http://100.88.0.6:47130': { pcId: 'pc-server', version: '0.5.9', trustTailnet: true },
  }

  await withBridge(health, async ({ url, probed }) => {
    const bridges = objects(arr((await api(url, '/api/tailnet/bridges')).json, 'bridges'))

    assert.deepEqual(
      bridges.map(item => [str(item, 'name'), str(item, 'baseUrl'), str(item, 'pcId'), bool(item, 'trustTailnet')]),
      [['laptop', 'http://100.88.0.3:47130', 'pc-laptop', true]],
    )
    // Only the account's own computers that are online are asked.
    assert.deepEqual([...new Set(probed.map(baseUrl => new URL(baseUrl).hostname))], ['100.88.0.3'])
  })
})

test('trusting the tailnet is the owner choice, and turning it off cuts the devices that came in through it', async () => {
  await withBridge({}, async ({ url, config }) => {
    const health = (await api(url, '/api/health')).json

    assert.equal(bool(health, 'trustTailnet'), false)
    assert.equal(str(health, 'pcId'), 'pc-self')

    // A claim on this PC's own (loopback) address is refused: claims come over the tailnet.
    assert.equal((await api(url, '/api/tailnet/claim', {}, {})).status, 403)

    const device = parseJsonObject(await (await fetch(`${url}/api/devices`, { method: 'POST', headers: authorized })).text())
    const phone = { Authorization: `Bearer ${str(device, 'token') ?? ''}`, 'Content-Type': 'application/json' }

    assert.equal((await api(url, '/api/tailnet/trust', { on: true }, phone)).status, 403)
    assert.equal((await api(url, '/api/tailnet/trust', { on: true })).status, 200)
    assert.equal(bool(obj((await api(url, '/api/snapshot')).json, 'server'), 'trustTailnet'), true)

    config.devices.push({ id: 'auto-1', name: 'pixel', hash: 'x', createdAt: Date.now(), lastSeen: null, tailnet: '100.88.0.2' })
    assert.equal((await api(url, '/api/tailnet/trust', { on: false })).status, 200)
    assert.deepEqual(
      config.devices.map(item => item.tailnet),
      [null],
    )
  })
})
