// Images Claude looked at, kept across bridge restarts so the gallery tab can
// be browsed later. Files Claude read are referenced by path; images a tool
// returned inline (screenshots) are written to disk under the gallery folder.
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { GalleryImage, GallerySummary, ImageSource } from '../../shared/protocol.ts'
import { arr, asObject, type Json, type JsonObject, num, objects, parseJsonObject, str } from './json.ts'
import { baseName } from './previews.ts'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}

const MAX_IMAGES = 300
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024
const MAX_CAPTURES_PER_CALL = 4
const SAME_FILE_MS = 60_000
const SAVE_DELAY_MS = 500

export function imageMime(path: string): string | null {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? null
}

export type InlineImage = {
  mime: string
  data: string
}

// Finds base64 images in a tool result, in the shapes the API (source.data)
// and MCP (data + mimeType) use.
export function inlineImages(value: Json | undefined, depth = 0): InlineImage[] {
  if (value === undefined || value === null || typeof value !== 'object' || depth > 6) return []
  if (Array.isArray(value)) return value.flatMap(item => inlineImages(item, depth + 1)).slice(0, MAX_CAPTURES_PER_CALL)

  if (str(value, 'type') === 'image') {
    const source = asObject(value.source)
    const data = str(source, 'data') ?? str(value, 'data')
    const mime = str(source, 'media_type') ?? str(value, 'mimeType') ?? str(value, 'mediaType')

    if (data !== null && mime !== null && EXT_BY_MIME[mime] !== undefined) return [{ mime, data }]
  }

  return Object.values(value)
    .flatMap(item => inlineImages(item, depth + 1))
    .slice(0, MAX_CAPTURES_PER_CALL)
}

// mcp__chrome__screenshot reads better as "chrome screenshot".
function shortTool(tool: string): string {
  return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool
}

export type ImageOrigin = {
  sessionId: string
  sessionName: string
  tool: string
}

function parseEntry(item: JsonObject): GalleryImage | null {
  const id = str(item, 'id')
  const source = str(item, 'source')
  const mime = str(item, 'mime')

  if (id === null || mime === null || (source !== 'file' && source !== 'capture')) return null

  return {
    id,
    sessionId: str(item, 'sessionId') ?? '',
    sessionName: str(item, 'sessionName') ?? '',
    name: str(item, 'name') ?? id,
    path: str(item, 'path'),
    source,
    tool: str(item, 'tool') ?? '',
    mime,
    at: num(item, 'at') ?? 0,
  }
}

export class Gallery {
  #entries: GalleryImage[] = []
  #saveTimer: NodeJS.Timeout | null = null
  readonly #dir: string
  readonly #now: () => number
  readonly #newId: () => string

  constructor(dir: string, now: () => number, newId: () => string) {
    this.#dir = dir
    this.#now = now
    this.#newId = newId
    this.#load()
  }

  get #indexPath(): string {
    return join(this.#dir, 'gallery.json')
  }

  get #captureDir(): string {
    return join(this.#dir, 'captures')
  }

  #load(): void {
    try {
      const parsed = parseJsonObject(readFileSync(this.#indexPath, 'utf8'))

      for (const item of objects(arr(parsed, 'images'))) {
        const entry = parseEntry(item)

        if (entry !== null) this.#entries.push(entry)
      }
    } catch {
      this.#entries = []
    }
  }

  #save(): void {
    this.#saveTimer ??= setTimeout(() => {
      this.#saveTimer = null
      try {
        mkdirSync(this.#dir, { recursive: true })
        writeFileSync(this.#indexPath, JSON.stringify({ images: this.#entries }))
      } catch {
        // The gallery is a convenience; losing the index loses no work.
      }
    }, SAVE_DELAY_MS)
  }

  #add(entry: GalleryImage): GalleryImage {
    this.#entries.push(entry)

    while (this.#entries.length > MAX_IMAGES) {
      const dropped = this.#entries.shift()

      if (dropped?.source === 'capture') this.#removeCapture(dropped)
    }

    this.#save()

    return entry
  }

  #capturePath(entry: GalleryImage): string {
    return join(this.#captureDir, `${entry.id}.${EXT_BY_MIME[entry.mime] ?? 'img'}`)
  }

  #removeCapture(entry: GalleryImage): void {
    try {
      unlinkSync(this.#capturePath(entry))
    } catch {
      // Already gone.
    }
  }

  addFile(origin: ImageOrigin, path: string, source: ImageSource = 'file'): GalleryImage | null {
    const mime = imageMime(path)

    if (mime === null || !existsSync(path)) return null

    const now = this.#now()
    const last = this.#entries.at(-1)

    // Reading the same picture again right away is one look, not two.
    if (last !== undefined && last.path === path && last.sessionId === origin.sessionId && now - last.at < SAME_FILE_MS) {
      last.at = now
      this.#save()

      return last
    }

    return this.#add({ id: this.#newId(), ...origin, name: baseName(path), path, source, mime, at: now })
  }

  // A picture read back from a file later (Codex's own record): once per
  // session, at the time it was made.
  addFileOnce(origin: ImageOrigin, path: string, at: number): GalleryImage | null {
    if (this.#entries.some(entry => entry.path === path && entry.sessionId === origin.sessionId)) return null

    const mime = imageMime(path)

    if (mime === null || !existsSync(path)) return null

    return this.#add({ id: this.#newId(), ...origin, name: baseName(path), path, source: 'file', mime, at })
  }

  addCapture(origin: ImageOrigin, image: InlineImage): GalleryImage | null {
    const bytes = Buffer.from(image.data, 'base64')

    if (bytes.length === 0 || bytes.length > MAX_CAPTURE_BYTES) return null

    const id = this.#newId()
    const entry: GalleryImage = {
      id,
      ...origin,
      name: `${shortTool(origin.tool)} ${new Date(this.#now()).toTimeString().slice(0, 8)}`,
      path: null,
      source: 'capture',
      mime: image.mime,
      at: this.#now(),
    }

    try {
      mkdirSync(this.#captureDir, { recursive: true })
      writeFileSync(this.#capturePath(entry), bytes)
    } catch {
      return null
    }

    return this.#add(entry)
  }

  // Where to read an entry's bytes from, or null when it is unknown or gone.
  file(id: string): { path: string; mime: string; size: number } | null {
    const entry = this.#entries.find(item => item.id === id)

    if (entry === undefined) return null

    const path = entry.source === 'capture' ? this.#capturePath(entry) : entry.path

    if (path === null) return null

    try {
      return { path, mime: entry.mime, size: statSync(path).size }
    } catch {
      return null
    }
  }

  // Newest first. A picture whose file was deleted since is left out rather
  // than shown broken.
  list(): GalleryImage[] {
    const shown: GalleryImage[] = []

    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index]

      if (entry !== undefined && this.file(entry.id) !== null) shown.push(entry)
    }

    return shown
  }

  // Takes one picture off the list. A screenshot the gallery stored itself
  // is deleted; a file Claude read stays where it is.
  remove(id: string): boolean {
    const index = this.#entries.findIndex(item => item.id === id)
    const entry = this.#entries[index]

    if (entry === undefined) return false

    this.#entries.splice(index, 1)
    if (entry.source === 'capture') this.#removeCapture(entry)
    this.#save()

    return true
  }

  clear(): number {
    const count = this.#entries.length

    for (const entry of this.#entries) {
      if (entry.source === 'capture') this.#removeCapture(entry)
    }

    this.#entries = []
    this.#save()

    return count
  }

  summary(): GallerySummary {
    return { count: this.#entries.length, latestAt: this.#entries.at(-1)?.at ?? 0 }
  }

  flush(): void {
    if (this.#saveTimer === null) return

    clearTimeout(this.#saveTimer)
    this.#saveTimer = null
    mkdirSync(this.#dir, { recursive: true })
    writeFileSync(this.#indexPath, JSON.stringify({ images: this.#entries }))
  }
}
