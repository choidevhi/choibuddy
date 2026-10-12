// Stands in for `codex app-server` in tests: lists the hooks of one
// hooks.json with a key and hash each, and records trust in a JSON file.
// usage: node fake-codex-app-server.ts <hooks.json> <state.json>
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { arr, type Json, type JsonObject, num, obj, objects, parseJsonObject, str } from '../src/json.ts'

const [hooksPath = '', statePath = ''] = process.argv.slice(2)

function readJson(path: string): JsonObject | null {
  return existsSync(path) ? parseJsonObject(readFileSync(path, 'utf8')) : null
}

function hooks(): Json[] {
  const state = readJson(statePath)
  const listed: Json[] = []

  const all = obj(readJson(hooksPath), 'hooks')

  for (const event of Object.keys(all ?? {})) {
    for (const [group, entry] of objects(arr(all, event)).entries()) {
      for (const [index, handler] of objects(arr(entry, 'hooks')).entries()) {
        const key = `${hooksPath}:${event}:${group}:${index}`
        const hash = `sha256:${createHash('sha256').update(JSON.stringify(handler)).digest('hex')}`

        listed.push({ key, eventName: event, handlerType: 'command', command: str(handler, 'command') ?? '', currentHash: hash, trustStatus: str(obj(state, key), 'trusted_hash') === hash ? 'trusted' : 'untrusted' })
      }
    }
  }

  return listed
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = parseJsonObject(line)
  const id = num(message, 'id')
  const method = str(message, 'method')

  if (id === null) continue

  if (method === 'hooks/list') {
    process.stdout.write(`${JSON.stringify({ id, result: { data: [{ cwd: '', hooks: hooks(), warnings: [], errors: [] }] } })}\n`)
  } else if (method === 'config/batchWrite') {
    const edit = objects(arr(obj(message, 'params'), 'edits'))[0] ?? null

    writeFileSync(statePath, JSON.stringify({ ...readJson(statePath), ...obj(edit, 'value') }))
    process.stdout.write(`${JSON.stringify({ id, result: {} })}\n`)
  } else {
    process.stdout.write(`${JSON.stringify({ id, result: {} })}\n`)
  }
}
