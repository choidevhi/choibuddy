// Instruction files Claude Code reads (CLAUDE.md, AGENTS.md, subagent
// definitions), for the user and for every project a session ran in. Only
// these names can be read or written, so the editor can't reach other files.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DocFile, DocGroup } from '../../shared/protocol.ts'

const PROJECT_FILES = ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', join('.claude', 'CLAUDE.md')]
// Shown even when missing, so they can be created.
const CREATABLE = new Set(['CLAUDE.md', 'AGENTS.md'])
const MAX_BYTES = 1_000_000

function idOf(path: string): string {
  return createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 16)
}

function describe(path: string, label: string): DocFile {
  try {
    const stat = statSync(path)

    return { id: idOf(path), label, path, exists: stat.isFile(), size: stat.size, mtime: stat.mtimeMs }
  } catch {
    return { id: idOf(path), label, path, exists: false, size: 0, mtime: 0 }
  }
}

function agentFiles(dir: string, labelDir: string): DocFile[] {
  try {
    return readdirSync(dir)
      .sort()
      .flatMap(name => (name.endsWith('.md') ? [describe(join(dir, name), `${labelDir}/${name}`)] : []))
  } catch {
    return []
  }
}

export type DocsResult = { ok: true; file: DocFile } | { ok: false; reason: 'unknown' | 'conflict' | 'too-large'; current: string | null }

export class Docs {
  readonly #claudeDir: string
  readonly #backupDir: string
  #known = new Map<string, string>()

  constructor(claudeDir: string, backupDir: string) {
    this.#claudeDir = claudeDir
    this.#backupDir = backupDir
  }

  list(projectDirs: string[]): DocGroup[] {
    const groups: DocGroup[] = [
      {
        key: 'user',
        title: '',
        cwd: null,
        files: [describe(join(this.#claudeDir, 'CLAUDE.md'), 'CLAUDE.md'), ...agentFiles(join(this.#claudeDir, 'agents'), 'agents')],
      },
    ]
    const seen = new Set<string>()
    // A session in the home folder would list ~/.claude/CLAUDE.md again as
    // its project's .claude/CLAUDE.md: each file appears once.
    const listed = new Set(groups.flatMap(group => group.files.map(file => file.id)))

    for (const cwd of projectDirs) {
      const key = cwd.toLowerCase()

      if (cwd === '' || seen.has(key)) continue
      seen.add(key)

      const candidates = [
        ...PROJECT_FILES.map(name => describe(join(cwd, name), name.replaceAll('\\', '/'))),
        ...agentFiles(join(cwd, '.claude', 'agents'), '.claude/agents'),
      ]
      const files: DocFile[] = []

      for (const file of candidates) {
        if (listed.has(file.id) || !(file.exists || CREATABLE.has(file.label) || file.label.startsWith('.claude/agents/'))) continue
        listed.add(file.id)
        files.push(file)
      }

      if (files.length > 0) groups.push({ key: idOf(cwd), title: basename(cwd), cwd, files })
    }

    this.#known = new Map(groups.flatMap(group => group.files.map(file => [file.id, file.path] as const)))

    return groups
  }

  #path(id: string): string | null {
    return this.#known.get(id) ?? null
  }

  read(id: string): { file: DocFile; text: string } | null {
    const path = this.#path(id)

    if (path === null) return null

    const file = describe(path, basename(path))

    if (!file.exists) return { file, text: '' }
    if (file.size > MAX_BYTES) return null

    return { file, text: readFileSync(path, 'utf8') }
  }

  // Saves unless the file changed since it was opened (baseMtime); the old
  // version is copied to the backup folder first.
  write(id: string, text: string, baseMtime: number): DocsResult {
    const path = this.#path(id)

    if (path === null) return { ok: false, reason: 'unknown', current: null }
    if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, reason: 'too-large', current: null }

    const before = describe(path, basename(path))

    if (before.exists && Math.abs(before.mtime - baseMtime) > 1) {
      return { ok: false, reason: 'conflict', current: readFileSync(path, 'utf8') }
    }

    if (before.exists) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')

      mkdirSync(this.#backupDir, { recursive: true })
      copyFileSync(path, join(this.#backupDir, `${stamp}-${idOf(path)}-${basename(path)}`))
    }

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)

    return { ok: true, file: describe(path, basename(path)) }
  }
}
