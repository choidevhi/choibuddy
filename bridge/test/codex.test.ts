import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codexAnswer, codexCommand, codexConnected, codexLaunchArgs, ensureCodexCommand, findCodexCli, patchFiles, patchLines, withCodexHooks } from '../src/codex.ts'
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
  // Codex allows its end and interrupt hooks 3 s at most.
  assert.equal((objects(arr(objects(arr(obj(again, 'hooks'), 'SessionEnd'))[0] ?? {}, 'hooks'))[0] ?? {}).timeout, 3)

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
  let installs = 0
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
    // No CLI at first: connecting installs one (a stand-in), whose app-server
    // (another stand-in) trusts the hooks.
    codexTools: {
      cli: () => (installs > 0 ? [process.execPath, '--no-warnings', join(import.meta.dirname, 'fake-codex-app-server.ts'), join(root, 'codex', 'hooks.json'), join(root, 'trust.json')] : null),
      app: () => null,
      install: async () => {
        installs += 1

        return true
      },
      command: () => true,
      launchArgs: () => ['--no-daemon'],
    },
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

    // Connecting writes the hooks with this bridge's own Node and script,
    // and has Codex's app-server (a stand-in here) trust all ten.
    const connected = parseJsonObject(await (await fetch(`${url}/api/codex`, { method: 'POST', headers, body: JSON.stringify({ on: true }) })).text())
    const file = parseJsonObject(readFileSync(join(root, 'codex', 'hooks.json'), 'utf8'))
    const trust = parseJsonObject(readFileSync(join(root, 'trust.json'), 'utf8'))

    assert.equal(installs, 1)
    assert.equal(connected?.cli, true)
    assert.equal(connected?.connected, true)
    assert.equal(connected?.trusted, true)
    assert.equal(Object.keys(trust ?? {}).length, 10)
    assert.equal(codexConnected(file), true)
    assert.match(str(objects(arr(objects(arr(obj(file, 'hooks'), 'Stop'))[0] ?? {}, 'hooks'))[0] ?? {}, 'command') ?? '', process.platform === 'win32' ? /^\S+node\.exe --no-warnings \S+ensure\.ts --codex$/i : /^('[^']*\/node'|\S*\/node) --no-warnings ('[^']*\/ensure\.ts'|\S*\/ensure\.ts) --codex$/)
  } finally {
    await bridge.close()
  }
})

test('a bridge not told where Codex lives leaves Codex alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-nocodex-'))
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
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  try {
    assert.equal(parseJsonObject(await (await fetch(`${url}/api/codex`, { headers })).text())?.connected, false)
    assert.equal((await fetch(`${url}/api/codex`, { method: 'POST', headers, body: JSON.stringify({ on: true }) })).status, 404)
  } finally {
    await bridge.close()
  }
})

test("the codex command is found on the PATH, in winget's links or as npm's shim", () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-codexcli-'))
  const npm = join(root, 'npm')
  const links = join(root, 'local', 'Microsoft', 'WinGet', 'Links')

  mkdirSync(npm, { recursive: true })
  mkdirSync(links, { recursive: true })
  assert.equal(findCodexCli({ PATH: npm, LOCALAPPDATA: join(root, 'local') }, 'win32'), null)

  writeFileSync(join(npm, 'codex.cmd'), '@echo off')
  assert.deepEqual(findCodexCli({ PATH: npm, LOCALAPPDATA: join(root, 'local') }, 'win32'), [join(npm, 'codex.cmd')])

  // winget's codex.exe wins over npm's shim, even outside the PATH.
  writeFileSync(join(links, 'codex.exe'), '')
  assert.deepEqual(findCodexCli({ PATH: npm, LOCALAPPDATA: join(root, 'local') }, 'win32'), [join(links, 'codex.exe')])
})

test("without winget's link, the unpacked program is found and `codex` gets a shim", () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-codexpkg-'))
  const pkg = join(root, 'local', 'Microsoft', 'WinGet', 'Packages', 'OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe')
  const env = { PATH: pkg, LOCALAPPDATA: join(root, 'local') }

  mkdirSync(pkg, { recursive: true })
  assert.equal(ensureCodexCommand(env, 'win32'), false)

  writeFileSync(join(pkg, 'codex-x86_64-pc-windows-msvc.exe'), '')
  assert.deepEqual(findCodexCli(env, 'win32'), [join(pkg, 'codex-x86_64-pc-windows-msvc.exe')])
  assert.equal(ensureCodexCommand(env, 'win32'), true)
  assert.match(readFileSync(join(pkg, 'codex.cmd'), 'utf8'), /"%~dp0codex-x86_64-pc-windows-msvc\.exe" %\*/)
  // The shim is now the `codex` command.
  assert.deepEqual(findCodexCli(env, 'win32'), [join(pkg, 'codex.cmd')])
})

test('the hook command reads the same in PowerShell, cmd and bash', () => {
  const keep = (path: string): string => path

  assert.equal(codexCommand('C:\\cb\\node.exe', 'C:\\cb\\bridge\\src\\ensure.ts', keep, 'win32'), 'C:/cb/node.exe --no-warnings C:/cb/bridge/src/ensure.ts --codex')
  // No short name for a path with spaces: PowerShell's call form.
  assert.equal(codexCommand('C:\\a b\\node.exe', 'C:\\cb\\ensure.ts', path => (path.includes(' ') ? null : path), 'win32'), '& "C:\\a b\\node.exe" --no-warnings "C:\\cb\\ensure.ts" --codex')
})

test('on macOS the codex command is `codex` on the PATH, and the hook command is POSIX-quoted', () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-codexmac-'))
  // Without a drive letter: its ":" would split a macOS PATH when this runs on Windows.
  const bin = join(root, 'bin').replace(/^[A-Za-z]:/, '')

  mkdirSync(bin, { recursive: true })
  assert.equal(findCodexCli({ PATH: `/nowhere:${bin}` }, 'darwin'), null)
  // Windows names mean nothing here.
  writeFileSync(join(bin, 'codex.cmd'), '')
  assert.equal(findCodexCli({ PATH: bin }, 'darwin'), null)
  assert.equal(ensureCodexCommand({ PATH: bin }, 'darwin'), false)

  writeFileSync(join(bin, 'codex'), '')
  assert.deepEqual(findCodexCli({ PATH: `/nowhere:${bin}` }, 'darwin'), [join(bin, 'codex')])

  const never = (): string | null => assert.fail('no short names on macOS')

  assert.equal(codexCommand('/Users/me/.choibuddy/app/node/node', '/Users/me/.choibuddy/app/bridge/src/ensure.ts', never, 'darwin'), '/Users/me/.choibuddy/app/node/node --no-warnings /Users/me/.choibuddy/app/bridge/src/ensure.ts --codex')
  assert.equal(codexCommand("/Users/Kim Lee/it's/node", '/x/ensure.ts', never, 'darwin'), "'/Users/Kim Lee/it'\\''s/node' --no-warnings /x/ensure.ts --codex")
})

test('Codex can run the hook through PowerShell and through cmd, as it does on Windows', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-shells-'))
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
  const home = join(root, 'home')
  const command = codexCommand(process.execPath, join(import.meta.dirname, '..', 'src', 'ensure.ts'))
  const run = (program: string, args: string[], verbatim: boolean, id: string): Promise<number | null> =>
    new Promise(resolve => {
      const child = spawn(program, args, { windowsVerbatimArguments: verbatim, windowsHide: true, env: { ...process.env, CHOIBUDDY_HOME: home } })

      child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: id, cwd: 'C:/work/app', transcript_path: null, model: 'gpt-5', permission_mode: 'default', source: 'startup' }))
      child.on('close', resolve)
    })

  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: bridge.port, token: TOKEN, pcId: 'pc-self', devices: [] }))

  try {
    // As Codex starts them: `powershell -NoProfile -Command <command>`, `cmd /C "<command>"`.
    assert.equal(await run('powershell.exe', ['-NoProfile', '-Command', command], false, 'via-powershell'), 0)
    assert.equal(await run(process.env.ComSpec ?? 'cmd.exe', ['/C', `"${command}"`], true, 'via-cmd'), 0)

    const sessions = objects(arr(parseJsonObject(await (await fetch(`http://127.0.0.1:${bridge.port}/api/snapshot`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text()), 'sessions'))

    assert.deepEqual(sessions.map(session => [str(session, 'id'), str(session, 'agent')]).sort(), [
      ['via-cmd', 'codex'],
      ['via-powershell', 'codex'],
    ])
  } finally {
    await bridge.close()
  }
})

test('Codex starts with --no-daemon only when it has that option', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-codex-flags-'))
  const today = join(root, 'new codex.cmd')
  const older = join(root, 'old.cmd')

  writeFileSync(today, '@echo       --no-daemon\r\n')
  writeFileSync(older, '@echo Usage: codex [OPTIONS]\r\n')

  assert.deepEqual(codexLaunchArgs(today), ['--no-daemon'])
  assert.deepEqual(codexLaunchArgs(older), [])
  assert.deepEqual(codexLaunchArgs(join(root, 'missing.exe')), [])
})

test("Codex's status answers when Windows won't start the Codex app's codex.exe: the CLI checks the trust", async () => {
  const root = mkdtempSync(join(tmpdir(), 'choibuddy-codex-app-'))
  let clock = Date.now()
  let appLookups = 0
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
    now: () => clock,
    codexHome: join(root, 'codex'),
    codexTools: {
      cli: () => [process.execPath, '--no-warnings', join(import.meta.dirname, 'fake-codex-app-server.ts'), join(root, 'codex', 'hooks.json'), join(root, 'trust.json')],
      // spawn throws for this one, as it does for some installs of the app (EPERM).
      app: () => {
        appLookups += 1

        return ['codex\u0000.exe']
      },
      install: async () => true,
      command: () => true,
      launchArgs: () => [],
    },
  })
  const url = `http://127.0.0.1:${bridge.port}`
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  try {
    const connect = await fetch(`${url}/api/codex`, { method: 'POST', headers, body: JSON.stringify({ on: true }) })
    const connected = parseJsonObject(await connect.text())

    assert.equal(connect.status, 200)
    assert.equal(connected?.trusted, true)

    // A minute on, the check runs again: still an answer, and the app was looked up once.
    clock += 61_000

    const asked = await fetch(`${url}/api/codex`, { headers })

    assert.equal(asked.status, 200)
    assert.equal(parseJsonObject(await asked.text())?.trusted, true)
    assert.equal(appLookups, 1)
  } finally {
    await bridge.close()
  }
})
