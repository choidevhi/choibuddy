// Codex (OpenAI's coding agent) runs command hooks much like Claude Code's.
// ChoiBuddy lists its own in ~/.codex/hooks.json; Codex runs them only once
// the person trusts them in its /hooks screen, so nothing runs behind their back.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { arr, type Json, type JsonObject, obj, objects, parseJsonObject, str } from './json.ts'

// Codex's hook events ChoiBuddy follows.
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'Interrupt', 'SessionEnd'] as const

// An approval waits for the person this long (the bridge answers by 590 s).
const PERMISSION_TIMEOUT_S = 600
// Everything else only reports, so it must not hold Codex up.
const REPORT_TIMEOUT_S = 10
// What marks ChoiBuddy's own entries among the person's hooks.
const MARK = '--codex'

export function codexHooksPath(codexHome: string): string {
  return join(codexHome, 'hooks.json')
}

// The command Codex runs: this PC's ChoiBuddy Node and hook script.
export function codexCommand(node: string, script: string): string {
  return `"${node}" --no-warnings "${script}" ${MARK}`
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
      const timeout = event === 'PermissionRequest' ? PERMISSION_TIMEOUT_S : REPORT_TIMEOUT_S

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
