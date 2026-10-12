// What people decided about sessions in ChoiBuddy: the names they gave them
// and which ended ones they put away. Kept in ~/.choibuddy/sessions.json;
// Claude Code's own transcripts are never written.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { arr, type JsonObject, obj, parseJsonObject, str, strings } from './json.ts'

// Long enough for any name a person types, short enough for a list row.
export const NAME_MAX = 120

export class SessionMeta {
  readonly #path: string
  readonly #names = new Map<string, string>()
  readonly #archived = new Set<string>()

  constructor(path: string) {
    this.#path = path

    let parsed: JsonObject | null = null

    try {
      parsed = parseJsonObject(readFileSync(path, 'utf8'))
    } catch {
      // No file yet: nothing named or put away.
    }

    const names = obj(parsed, 'names')

    for (const key of Object.keys(names ?? {})) {
      const name = str(names, key)

      if (name !== null && name !== '') this.#names.set(key, name.slice(0, NAME_MAX))
    }

    for (const id of strings(arr(parsed, 'archived'))) this.#archived.add(id)
  }

  name(sessionId: string): string | null {
    return this.#names.get(sessionId) ?? null
  }

  get names(): ReadonlyMap<string, string> {
    return this.#names
  }

  // An empty name goes back to the one Claude Code gave the session.
  rename(sessionId: string, name: string): string | null {
    const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)

    if (trimmed === '') this.#names.delete(sessionId)
    else this.#names.set(sessionId, trimmed)
    this.#save()

    return trimmed === '' ? null : trimmed
  }

  archived(sessionId: string): boolean {
    return this.#archived.has(sessionId)
  }

  setArchived(sessionIds: string[], archived: boolean): number {
    let changed = 0

    for (const id of sessionIds) {
      if (this.#archived.has(id) === archived) continue
      if (archived) this.#archived.add(id)
      else this.#archived.delete(id)
      changed += 1
    }

    if (changed > 0) this.#save()

    return changed
  }

  // A session moved to the trash takes its name and its place in the archive along.
  forget(sessionId: string): void {
    const named = this.#names.delete(sessionId)
    const archived = this.#archived.delete(sessionId)

    if (named || archived) this.#save()
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    writeFileSync(this.#path, `${JSON.stringify({ names: Object.fromEntries(this.#names), archived: [...this.#archived] }, null, 2)}\n`)
  }
}
