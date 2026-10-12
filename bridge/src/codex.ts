// Codex (OpenAI's coding agent) runs command hooks much like Claude Code's.
// ChoiBuddy lists its own in ~/.codex/hooks.json; Codex runs them only once
// the person trusts them in its /hooks screen, so nothing runs behind their back.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { arr, type Json, type JsonObject, num, obj, objects, parseJsonObject, str } from './json.ts'

// Codex's hook events ChoiBuddy follows.
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'Interrupt', 'SessionEnd'] as const

// An approval waits for the person this long (the bridge answers by 590 s).
const PERMISSION_TIMEOUT_S = 600
// Everything else only reports, so it must not hold Codex up.
const REPORT_TIMEOUT_S = 10
// Codex cuts these two to 3 s anyway (and warns when asked for more).
const SHORT_EVENTS = new Set(['SessionEnd', 'Interrupt'])
const SHORT_TIMEOUT_S = 3
// How long Codex's app-server gets to answer while trusting the hooks.
const APP_SERVER_MS = 20_000
// How long installing the Codex CLI may take (it is a large download).
const INSTALL_MS = 10 * 60_000
// What marks ChoiBuddy's own entries among the person's hooks.
const MARK = '--codex'

export function codexHooksPath(codexHome: string): string {
  return join(codexHome, 'hooks.json')
}

// A Windows path without spaces: its short 8.3 form when it has any (null
// when the drive keeps no short names).
function shortPath(path: string): string | null {
  if (!/\s/.test(path)) return path

  // Handed to cmd as typed: Node's own quoting would escape the inner quotes.
  const found = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 5000 })
  const short = found.status === 0 ? found.stdout.trim() : ''

  return short === '' || /\s/.test(short) ? null : short
}

// The command Codex runs: this PC's ChoiBuddy Node and hook script. Codex
// hands it to the session's shell (PowerShell on Windows, or cmd, or bash),
// so it is written to read the same in all three: forward slashes and no
// quotes (PowerShell takes a quoted path for a string, not a program). A path
// with spaces goes short; without short names, PowerShell's own form is left.
export function codexCommand(node: string, script: string, shorten: (path: string) => string | null = shortPath): string {
  const program = shorten(node)
  const file = shorten(script)

  if (program === null || file === null) return `& "${node}" --no-warnings "${script}" ${MARK}`

  return `${program.replace(/\\/g, '/')} --no-warnings ${file.replace(/\\/g, '/')} ${MARK}`
}

function ours(hook: JsonObject): boolean {
  const command = str(hook, 'command') ?? ''

  return command.includes('ensure.ts') && command.includes(MARK)
}

function readHooksFile(path: string): JsonObject | null {
  try {
    return parseJsonObject(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// The person's own groups for an event, with ChoiBuddy's taken out.
function othersFor(hooks: JsonObject | null, event: string): JsonObject[] {
  return objects(arr(hooks, event)).flatMap(group => {
    const kept = objects(arr(group, 'hooks')).filter(hook => !ours(hook))

    return kept.length === 0 ? [] : [{ ...group, hooks: kept }]
  })
}

// hooks.json with ChoiBuddy's hooks in (command set) or out (null); the
// person's own hooks and events stay as they were.
export function withCodexHooks(file: JsonObject | null, command: string | null): JsonObject {
  const hooks = obj(file, 'hooks')
  const events = new Set<string>([...Object.keys(hooks ?? {}), ...CODEX_EVENTS])
  const next: Record<string, Json> = {}

  for (const event of events) {
    const groups: JsonObject[] = othersFor(hooks, event)

    if (command !== null && CODEX_EVENTS.some(item => item === event)) {
      const timeout = event === 'PermissionRequest' ? PERMISSION_TIMEOUT_S : SHORT_EVENTS.has(event) ? SHORT_TIMEOUT_S : REPORT_TIMEOUT_S

      groups.push({ hooks: [{ type: 'command', command, commandWindows: command, timeout }] })
    }

    if (groups.length > 0) next[event] = groups
  }

  const description = str(file, 'description')

  return description === null ? { hooks: next } : { description, hooks: next }
}

export function codexConnected(file: JsonObject | null): boolean {
  const hooks = obj(file, 'hooks')

  return CODEX_EVENTS.every(event => objects(arr(hooks, event)).some(group => objects(arr(group, 'hooks')).some(ours)))
}

export type CodexState = { installed: boolean; connected: boolean }

// Whether hooks.json already holds ChoiBuddy's hooks exactly as `command`
// and this version would write them.
export function codexHooksCurrent(codexHome: string, command: string): boolean {
  const file = readHooksFile(codexHooksPath(codexHome))

  return JSON.stringify(withCodexHooks(file, command)) === JSON.stringify(file)
}

export function codexState(codexHome: string): CodexState {
  return { installed: existsSync(codexHome), connected: codexConnected(readHooksFile(codexHooksPath(codexHome))) }
}

// Writes ChoiBuddy's hooks in or out. The file before goes to hooks.json.bak.
export function setCodexHooks(codexHome: string, command: string | null): CodexState {
  const path = codexHooksPath(codexHome)
  const before = readHooksFile(path)

  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) renameSync(path, `${path}.bak`)
  writeFileSync(path, `${JSON.stringify(withCodexHooks(before, command), null, 2)}\n`)

  return codexState(codexHome)
}

// The bridge answers an approval the way Claude Code takes it; Codex takes
// only allow or deny (an always-allow or rewritten input would make it fail
// closed), so the answer is cut down to that. Empty: no answer, Codex asks
// in its own window.
export function codexAnswer(reply: JsonObject | null): string {
  const decision = obj(obj(reply, 'hookSpecificOutput'), 'decision')
  const behavior = str(decision, 'behavior')

  if (behavior !== 'allow' && behavior !== 'deny') return ''

  const message = str(decision, 'message')
  const answer = message === null ? { behavior } : { behavior, message }

  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: answer } })
}

// The files an apply_patch touches, in order.
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].flatMap(match => (match[1] === undefined ? [] : [match[1].trim()]))
}

// The first file's changed lines: what was added and taken out.
export function patchLines(patch: string): Array<{ text: string; mark: 'add' | 'del' | 'none' }> {
  const lines: Array<{ text: string; mark: 'add' | 'del' | 'none' }> = []
  let files = 0

  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('*** ')) {
      if (/^\*\*\* (Update|Add|Delete) File: /.test(line)) files += 1
      if (files > 1) break

      continue
    }

    if (files === 0 || line.startsWith('@@')) continue
    if (line.startsWith('+')) lines.push({ text: line.slice(1), mark: 'add' })
    else if (line.startsWith('-')) lines.push({ text: line.slice(1), mark: 'del' })
    else lines.push({ text: line.startsWith(' ') ? line.slice(1) : line, mark: 'none' })
  }

  return lines
}

// Whether a hook came from Codex (ChoiBuddy's Codex hook marks it).
export function fromCodex(raw: JsonObject): boolean {
  return str(raw, 'agent') === 'codex'
}

// The `codex` command people type: a codex.exe on the PATH or in winget's
// links folder, else a codex.cmd (npm's, or ChoiBuddy's below).
function findCodexCommand(env: NodeJS.ProcessEnv): string | null {
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter), join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links')]

  for (const name of ['codex.exe', 'codex.cmd']) {
    for (const dir of dirs) {
      const candidate = join(dir, name)

      if (dir !== '' && existsSync(candidate)) return candidate
    }
  }

  return null
}

// Where winget unpacks the Codex CLI. Its link named `codex` needs
// Developer Mode (a symlink); without it winget only puts this folder on the
// PATH, where the program is codex-<arch>-pc-windows-msvc.exe.
function wingetCodex(env: NodeJS.ProcessEnv): string | null {
  const packages = join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages')
  let folders: string[] = []

  try {
    folders = readdirSync(packages).filter(name => name.startsWith('OpenAI.Codex_'))
  } catch {
    return null
  }

  for (const folder of folders) {
    for (const name of ['codex-x86_64-pc-windows-msvc.exe', 'codex-aarch64-pc-windows-msvc.exe']) {
      const candidate = join(packages, folder, name)

      if (existsSync(candidate)) return candidate
    }
  }

  return null
}

// The Codex CLI: the `codex` command, else winget's unpacked program. Null
// without either.
export function findCodexCli(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const found = findCodexCommand(env) ?? wingetCodex(env)

  return found === null ? null : [found]
}

// Makes `codex` work in a terminal after a winget install without its link:
// a codex.cmd beside the program, in the folder winget put on the PATH.
export function ensureCodexCommand(env: NodeJS.ProcessEnv = process.env): boolean {
  if (findCodexCommand(env) !== null) return true

  const program = wingetCodex(env)

  if (program === null) return false

  writeFileSync(join(dirname(program), 'codex.cmd'), `@echo off\r\n"%~dp0${basename(program)}" %*\r\n`)

  return true
}

// codex.exe inside the Codex app (its Windows Store package). Null without it.
export function findCodexApp(): string[] | null {
  const found = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-AppxPackage -Name OpenAI.Codex).InstallLocation'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
  const location = found.status === 0 ? found.stdout.trim() : ''
  const bundled = join(location, 'app', 'resources', 'codex.exe')

  return location !== '' && existsSync(bundled) ? [bundled] : null
}

// Installs OpenAI's Codex CLI (winget package OpenAI.Codex) for this user.
export function installCodexCli(): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(
      'winget',
      ['install', '--id', 'OpenAI.Codex', '--exact', '--source', 'winget', '--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
      { stdio: 'ignore', windowsHide: true },
    )
    const timer = setTimeout(() => child.kill(), INSTALL_MS)

    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', code => {
      clearTimeout(timer)
      resolve(code === 0 && ensureCodexCommand())
    })
  })
}

// How ChoiBuddy reaches Codex's programs on this PC (stand-ins in tests).
export type CodexTools = {
  cli: () => string[] | null
  app: () => string[] | null
  install: () => Promise<boolean>
  // Makes sure typing `codex` works; false when there is no CLI to point at.
  command: () => boolean
}

export const CODEX_TOOLS: CodexTools = { cli: findCodexCli, app: findCodexApp, install: installCodexCli, command: ensureCodexCommand }

export type CodexTrust = { ours: number; trusted: number }

// Talks to Codex's own app-server, which works out each hook's key and hash
// the way this Codex version does, and records trust the way its /hooks
// screen does. `trust` false only looks.
export function codexTrust(command: string[], cwd: string, trust: boolean): Promise<CodexTrust | null> {
  const [program, ...args] = command

  if (program === undefined) return Promise.resolve(null)

  return new Promise(resolve => {
    // npm's codex.cmd runs through the shell.
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: program.toLowerCase().endsWith('.cmd') })
    const waiting = new Map<number, (reply: JsonObject) => void>()
    let buffered = ''
    let nextId = 1

    const finish = (result: CodexTrust | null): void => {
      clearTimeout(timer)
      child.kill()
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), APP_SERVER_MS)

    child.on('error', () => finish(null))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk

      const lines = buffered.split('\n')

      buffered = lines.pop() ?? ''

      for (const line of lines) {
        const message = parseJsonObject(line)
        const id = num(message, 'id')

        if (message !== null && id !== null) waiting.get(id)?.(message)
      }
    })

    const send = (method: string, params: JsonObject): Promise<JsonObject> =>
      new Promise(answer => {
        const id = nextId

        nextId += 1
        waiting.set(id, answer)
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
      })

    // ChoiBuddy's hooks as Codex sees them: [key, hash, trusted].
    const ourHooks = async (): Promise<Array<[string, string, boolean]>> => {
      const listed = await send('hooks/list', { cwds: [cwd] })

      return objects(arr(obj(listed, 'result'), 'data')).flatMap(entry =>
        objects(arr(entry, 'hooks')).flatMap((hook): Array<[string, string, boolean]> => {
          const key = str(hook, 'key')
          const hash = str(hook, 'currentHash')

          return key === null || hash === null || !ours(hook) ? [] : [[key, hash, str(hook, 'trustStatus') === 'trusted']]
        }),
      )
    }

    void (async () => {
      const started = await send('initialize', { clientInfo: { name: 'choibuddy', title: 'ChoiBuddy', version: '1' }, capabilities: null })

      if (obj(started, 'error') !== null) {
        finish(null)

        return
      }

      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)

      const before = await ourHooks()
      const untrusted = before.filter(([, , trusted]) => !trusted)

      if (trust && untrusted.length > 0) {
        const state: Record<string, Json> = {}

        for (const [key, hash] of untrusted) state[key] = { trusted_hash: hash }

        const written = await send('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value: state, mergeStrategy: 'upsert' }], reloadUserConfig: false })

        if (obj(written, 'error') !== null) {
          finish(null)

          return
        }
      }

      const after = trust && untrusted.length > 0 ? await ourHooks() : before

      finish({ ours: after.length, trusted: after.filter(([, , trusted]) => trusted).length })
    })()
  })
}
