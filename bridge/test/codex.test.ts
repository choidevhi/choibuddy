import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codexAnswer, codexConnected, patchFiles, patchLines, withCodexHooks } from '../src/codex.ts'
import { arr, type JsonObject, obj, objects, parseJsonObject, str } from '../src/json.ts'
import { startBridge } from '../src/server.ts'

const TOKEN = 'test-token-0123456789abcdefghijklmnop'
const COMMAND = '"C:/cb/node.exe" --no-warnings "C:/cb/bridge/src/ensure.ts" --codex'
const PATCH = ['*** Begin Patch', '*** Update File: src/sort.ts', '@@ export function sortProducts', '-  return items.sort((a, b) => a.price > b.price ? 1 : -1)', '+  return items.sort((a, b) => a.price - b.price)', '   // keeps the order stable', '*** Add File: src/sort.test.ts', '+test()', '*** End Patch'].join('\n')

test("ChoiBuddy's hooks go into Codex's hooks.json and out again, the person's own stay", () => {
  const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }], PreCompact: [{ hooks: [{ type: 'command', command: 'backup' }] }] }, description: 'mine' }
  const added = withCodexHooks(mine, COMMAND)
  const again = withCodexHooks(added, COMMAND)
  const stops = objects(arr(obj(again, 'hooks'), 'Stop'))

  assert.equal(codexConnected(added), true)
  // Adding twice keeps one entry; the person's Stop hook is still first.
  assert.equal(stops.length, 2)
  assert.equal(str(objects(arr(stops[0] ?? {}, 'hooks'))[0] ?? {}, 'command'), 'notify-me')

  const permission = objects(arr(objects(arr(obj(again, 'hooks'), 'PermissionRequest'))[0] ?? {}, 'hooks'))[0] ?? {}

  assert.equal(str(permission, 'commandWindows'), COMMAND)
  assert.equal(permission.timeout, 600)

  const removed = withCodexHooks(again, null)

  assert.equal(codexConnected(removed), false)
  assert.deepEqual(removed, mine)
})

test('an answer is cut down to what Codex takes, and none means Codex asks itself', () => {
  const allow = codexAnswer({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: [{ type: 'addRules' }] } } })

  assert.deepEqual(parseJsonObject(allow), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  assert.deepEqual(parseJsonObject(codexAnswer({ hookSpecificOutput: { decision: { behavior: 'deny', message: 'not now' } } })), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'not now' } },
  })
  assert.equal(codexAnswer({}), '')
  assert.equal(codexAnswer(null), '')
})

test("apply_patch shows the files it touches and the first file's changes", () => {
  assert.deepEqual(patchFiles(PATCH), ['src/sort.ts', 'src/sort.test.ts'])
  assert.deepEqual(
    patchLines(PATCH).map(line => line.mark),
    ['del', 'add', 'none'],
  )
})

test('a Codex session shows its steps, asks through the hook script and reads its rollout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-codex-'))
  const rollout = join(root, 'rollout-test.jsonl')
  const at = new Date(Date.UTC(2026, 9, 12, 3)).toISOString()

  writeFileSync(
    rollout,
    [
      { timestamp: at, type: 'session_meta', payload: { id: 'cx1', cwd: 'C:/work/shop' } },
      { timestamp: at, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '# Files mentioned by the user:\n\n## a.png: C:/tmp/a.png\n\n## My request:\n정렬 고쳐줘' }] } } },
      { timestamp: at, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: '고칠게요.' }], phase: 'final_answer' } } },
    ]
      .map(line => JSON.stringify(line))
      .join('\n') + '\n',
  )

  const bridge = await startBridge({
    config: { port: 0, token: TOKEN, pcId: 'pc-self', devices: [], trustTailnet: false, autoLanguage: null },
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
  })
  const url = `http://127.0.0.1:${bridge.port}`
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  const base = { session_id: 'cx1', cwd: 'C:/work/shop', transcript_path: rollout, permission_mode: 'default', model: 'gpt-5', agent: 'codex' }
  const hook = (payload: JsonObject): Promise<Response> => fetch(`${url}/hook`, { method: 'POST', body: JSON.stringify({ ...base, ...payload }) })
  const session = async (): Promise<JsonObject> => objects(arr(parseJsonObject(await (await fetch(`${url}/api/snapshot`, { headers })).text()), 'sessions'))[0] ?? {}

  try {
    await hook({ hook_event_name: 'SessionStart', source: 'startup' })
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: { command: PATCH }, turn_id: 't1' })

    const started = await session()
    const step = objects(arr(started, 'steps'))[0] ?? {}

    assert.equal(str(started, 'agent'), 'codex')
    assert.equal(str(step, 'kind'), 'edit')
    assert.equal(str(step, 'title'), 'sort.ts +1')
    assert.equal(objects(arr(obj(step, 'preview'), 'lines')).length, 3)

    // The hook script, as Codex runs it, waits for the person's answer.
    const home = join(root, 'home')

    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify({ port: bridge.port, token: TOKEN, pcId: 'pc-self', devices: [] }))

    const child = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, '..', 'src', 'ensure.ts'), '--codex'], { env: { ...process.env, CHOIBUDDY_HOME: home } })
    const out: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stdin.end(JSON.stringify({ ...base, agent: undefined, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm test' }, turn_id: 't1' }))

    let pendingId: string | null = null

    for (let i = 0; i < 50 && pendingId === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      pendingId = str(objects(arr(parseJsonObject(await (await fetch(`${url}/api/snapshot`, { headers })).text()), 'pending'))[0] ?? {}, 'id')
    }

    assert.notEqual(pendingId, null)
    await fetch(`${url}/api/decide`, { method: 'POST', headers, body: JSON.stringify({ id: pendingId, behavior: 'allow' }) })
    await new Promise(resolve => child.on('close', resolve))
    assert.deepEqual(parseJsonObject(Buffer.concat(out).toString('utf8')), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })

    await hook({ hook_event_name: 'Interrupt', turn_id: 't1' })
    assert.equal(str(await session(), 'status'), 'idle')

    // The chat reads Codex's rollout: the request without the file list.
    const talk = parseJsonObject(await (await fetch(`${url}/api/conversation?session=cx1`, { headers })).text())

    assert.deepEqual(
      objects(arr(talk, 'messages')).map(message => [str(message, 'role'), str(message, 'text')]),
      [
        ['user', '정렬 고쳐줘'],
        ['assistant', '고칠게요.'],
      ],
    )

    // Connecting writes the hooks with this bridge's own Node and script.
    const connected = parseJsonObject(await (await fetch(`${url}/api/codex`, { method: 'POST', headers, body: JSON.stringify({ on: true }) })).text())
    const file = parseJsonObject(readFileSync(join(root, 'codex', 'hooks.json'), 'utf8'))

    assert.equal(connected?.connected, true)
    assert.equal(codexConnected(file), true)
    assert.ok((str(objects(arr(objects(arr(obj(file, 'hooks'), 'Stop'))[0] ?? {}, 'hooks'))[0] ?? {}, 'command') ?? '').includes(process.execPath))
  } finally {
    await bridge.close()
  }
})
