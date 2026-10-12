// Adds and removes ChoiBuddy's entries in Claude Code's settings.hooks
// without touching anyone else's hooks.
import { arr, asObject, type Json, type JsonObject, obj, objects, str } from './json.ts'

const QUICK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
] as const

const ENSURE_EVENTS = ['SessionStart', 'UserPromptSubmit'] as const

// Long enough for someone to pick up the phone; the bridge answers "no
// decision" at 590 s so the terminal dialog keeps working after that.
const PERMISSION_TIMEOUT_S = 600
const QUICK_TIMEOUT_S = 5

const MARK_HEADER = 'X-ChoiBuddy'

// Ours: an http hook carrying our marker header, or a command that runs a
// file under ~/.choibuddy. Everything else in settings is left alone.
function isOurs(hook: JsonObject): boolean {
  const headers = obj(hook, 'headers')
  const command = str(hook, 'command') ?? ''

  return str(headers, MARK_HEADER) !== null || command.includes('.choibuddy')
}

function httpHook(port: number, timeout: number): JsonObject {
  return { type: 'http', url: `http://127.0.0.1:${port}/hook`, timeout, headers: { [MARK_HEADER]: '1' } }
}

export function withoutOurHooks(hooks: JsonObject): JsonObject {
  const out: JsonObject = {}

  for (const [event, groups] of Object.entries(hooks)) {
    const kept: Json[] = []

    for (const group of Array.isArray(groups) ? groups : []) {
      const groupObject = asObject(group)

      if (groupObject === null) {
        kept.push(group)
        continue
      }

      const inner = objects(arr(groupObject, 'hooks')).filter(hook => !isOurs(hook))

      if (inner.length > 0) kept.push({ ...groupObject, hooks: inner })
    }

    if (kept.length > 0) out[event] = kept
  }

  return out
}

// `nodePath` is ChoiBuddy's own Node (see install.ts), named in full so the
// hooks work without a Node on the PATH.
export function withOurHooks(hooks: JsonObject, port: number, ensurePath: string, nodePath: string): JsonObject {
  const out = withoutOurHooks(hooks)
  const command = `"${nodePath.replaceAll('\\', '/')}" --no-warnings "${ensurePath.replaceAll('\\', '/')}" --forward`
  const add = (event: string, hook: JsonObject): void => {
    const groups = out[event]

    out[event] = [...(Array.isArray(groups) ? groups : []), { hooks: [hook] }]
  }

  for (const event of ENSURE_EVENTS) add(event, { type: 'command', command, timeout: 10 })
  for (const event of QUICK_EVENTS) add(event, httpHook(port, QUICK_TIMEOUT_S))
  add('PermissionRequest', httpHook(port, PERMISSION_TIMEOUT_S))

  return out
}
