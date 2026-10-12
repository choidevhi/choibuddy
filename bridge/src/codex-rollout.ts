// What Codex writes into its rollout file that its hooks leave out: the
// model and effort a turn runs with, token use and the context window, the
// account's 5-hour and weekly windows, and the pictures it made or looked
// at. Read a piece at a time, from where the last read of that file stopped.
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type JsonObject, num, obj, parseJsonObject, str } from './json.ts'

export type CodexWindow = { kind: string; percentUsed: number; resetsAt: string | null }

export type CodexPicture = { path: string; at: number; tool: string }

export type CodexReading = {
  model: string | null
  effort: string | null
  // From the latest token count: the context in use and its window, and the
  // thread's totals so far (input includes the cached part).
  contextTokens: number | null
  contextWindow: number | null
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
  windows: CodexWindow[]
  pictures: CodexPicture[]
}

// A file read in one go at most; a longer one is read over several calls.
const MAX_READ = 16 * 1024 * 1024

function emptyReading(): CodexReading {
  return { model: null, effort: null, contextTokens: null, contextWindow: null, inputTokens: null, cachedTokens: null, outputTokens: null, windows: [], pictures: [] }
}

// Codex names its windows by length: 300 minutes is the 5-hour one, 10080
// the weekly one (the names the Claude windows use, so the screens match).
function windowKind(minutes: number | null): string {
  if (minutes === 300) return 'five_hour'
  if (minutes === 10080) return 'seven_day'

  return minutes === null ? 'window' : `${minutes}m`
}

function windowOf(limit: JsonObject | null): CodexWindow | null {
  const used = num(limit, 'used_percent')

  if (limit === null || used === null) return null

  const resets = num(limit, 'resets_at')

  return { kind: windowKind(num(limit, 'window_minutes')), percentUsed: used, resetsAt: resets === null ? null : new Date(resets * 1000).toISOString() }
}

// A picture's path: Codex writes local files plainly or as file:// URLs.
function localPath(path: string | null): string | null {
  if (path === null || path === '') return null

  try {
    return path.startsWith('file:') ? fileURLToPath(path) : path
  } catch {
    return null
  }
}

function applyLine(reading: CodexReading, line: JsonObject): void {
  const type = str(line, 'type')
  const payload = obj(line, 'payload')
  const stamp = Date.parse(str(line, 'timestamp') ?? '')
  const at = Number.isFinite(stamp) ? stamp : Date.now()

  if (type === 'turn_context') {
    reading.model = str(payload, 'model') ?? reading.model
    reading.effort = str(payload, 'effort') ?? str(payload, 'reasoning_effort') ?? reading.effort

    return
  }

  if (type !== 'event_msg') return

  const kind = str(payload, 'type')

  if (kind === 'thread_settings_applied') {
    const settings = obj(payload, 'thread_settings')

    reading.model = str(settings, 'model') ?? reading.model
    reading.effort = str(settings, 'reasoning_effort') ?? reading.effort

    return
  }

  if (kind === 'token_count') {
    const info = obj(payload, 'info')
    const total = obj(info, 'total_token_usage')
    const last = obj(info, 'last_token_usage')
    const limits = obj(payload, 'rate_limits')
    const windows = [windowOf(obj(limits, 'primary')), windowOf(obj(limits, 'secondary'))].flatMap(window => (window === null ? [] : [window]))

    if (info !== null) {
      reading.contextTokens = num(last, 'total_tokens') ?? reading.contextTokens
      reading.contextWindow = num(info, 'model_context_window') ?? reading.contextWindow
      reading.inputTokens = num(total, 'input_tokens') ?? reading.inputTokens
      reading.cachedTokens = num(total, 'cached_input_tokens') ?? reading.cachedTokens
      reading.outputTokens = num(total, 'output_tokens') ?? reading.outputTokens
    }

    if (windows.length > 0) reading.windows = windows

    return
  }

  if (kind !== 'item_completed') return

  const item = obj(payload, 'item')
  const itemType = str(item, 'type')

  // A picture Codex made (its image tool saves each one) or opened.
  if (itemType === 'Extension' && str(item, 'kind') === 'image_gen.generation') {
    const path = localPath(str(item, 'savedPath'))

    if (path !== null) reading.pictures.push({ path, at, tool: 'image_gen' })
  } else if (itemType === 'ImageView') {
    const path = localPath(str(item, 'path'))

    if (path !== null) reading.pictures.push({ path, at, tool: 'view_image' })
  }
}

export class CodexRollouts {
  // Where each file was read up to, and the bytes of a line not finished
  // yet (kept as bytes: a character may be cut in two).
  readonly #read = new Map<string, { offset: number; rest: Buffer }>()

  // What was added to the rollout at `path` since the last read (all of it
  // the first time); null when nothing new or the file cannot be read.
  read(path: string): CodexReading | null {
    let size = 0

    try {
      size = statSync(path).size
    } catch {
      return null
    }

    const last = this.#read.get(path) ?? { offset: 0, rest: Buffer.alloc(0) }
    // A file that shrank was written anew.
    const from = size < last.offset ? 0 : last.offset

    if (size === from) return null

    const length = Math.min(size - from, MAX_READ)
    const buffer = Buffer.alloc(length)
    let fd: number | null = null

    try {
      fd = openSync(path, 'r')
      readSync(fd, buffer, 0, length, from)
    } catch {
      return null
    } finally {
      if (fd !== null) closeSync(fd)
    }

    const bytes = from === last.offset ? Buffer.concat([last.rest, buffer]) : buffer
    const end = bytes.lastIndexOf(0x0a) + 1
    const reading = emptyReading()

    this.#read.set(path, { offset: from + length, rest: bytes.subarray(end) })

    for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
      const parsed = parseJsonObject(line)

      if (parsed !== null) applyLine(reading, parsed)
    }

    return reading
  }
}
