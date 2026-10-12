// Terminals that live on this PC and show inside the app: a shell (or
// Claude Code, or Codex) in a real pseudo-terminal, typed into from the
// widget or the phone. Output is kept, so a screen that joins later (or
// another device) sees what came before.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The parts of node-pty this file uses.
type Pty = {
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (event: { exitCode: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
}

type PtyModule = {
  spawn: (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => Pty
}

// What a terminal runs: the shell, or a coding agent started in it.
export type TermRun = 'shell' | 'claude' | 'codex'

export type TermInfo = {
  id: string
  title: string
  cwd: string
  run: TermRun
  startedAt: number
  exitCode: number | null
  exited: boolean
}

type Listener = { data: (chunk: string) => void; exit: (code: number) => void }

// `paste`: the program in it asked for pastes marked as such (bracketed
// paste), so typed text with line breaks goes in as one message.
type Term = TermInfo & { pty: Pty; backlog: string; listeners: Set<Listener>; paste: boolean }

// What a program running in the terminal is told about it, so ChoiBuddy's
// Codex hooks can name the terminal their session runs in.
export const TERM_ENV = 'CHOIBUDDY_TERM'
// Esc first (Codex stops on it), then the message once that settled.
const ESC_SETTLE_MS = 300
// Enter waits this long after the text: Codex reads fast typing as a paste
// and an Enter right after it as a new line, not as send.
const ENTER_AFTER_MS = 600

// Output kept for a screen that joins later.
const BACKLOG_CHARS = 256 * 1024
const MAX_TERMS = 12
const MIN_SIZE = 10
const MAX_COLS = 400
const MAX_ROWS = 200

// node-pty ships as a native addon: in the installed app it sits beside the
// bridge (app/pty), in the source tree in node_modules.
function loadPty(): PtyModule | null {
  const require = createRequire(import.meta.url)
  const beside = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pty', 'node_modules', '@lydell', 'node-pty')

  for (const candidate of existsSync(beside) ? [beside, '@lydell/node-pty'] : ['@lydell/node-pty']) {
    try {
      const loaded: PtyModule = require(candidate)

      return loaded
    } catch {
      // Try the next place.
    }
  }

  return null
}

// The PATH as Windows has it now: one set after the bridge started (an
// install that added a folder) reaches new terminals too.
function freshPath(): string | null {
  if (process.platform !== 'win32') return null

  const read = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  })
  const path = read.status === 0 ? read.stdout.trim() : ''

  return path === '' ? null : path
}

function clampSize(value: number, max: number): number {
  return Math.min(max, Math.max(MIN_SIZE, Math.floor(Number.isFinite(value) ? value : 80)))
}

// Text the terminal's shell takes as one literal string: PowerShell's single
// quotes on Windows (a typographic quote ends them too), POSIX single quotes
// elsewhere. A control character would act as a key, so it goes.
function literal(text: string, platform: NodeJS.Platform): string {
  const plain = text.replace(/[\x00-\x1f\x7f]+/g, ' ')

  return platform === 'win32' ? `'${plain.replace(/['‘’‚‛]/g, "''")}'` : `'${plain.replace(/'/g, `'\\''`)}'`
}

// A word left bare when nothing in it means anything to the shell.
function word(text: string, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? /^[\w:./\\-]+$/ : /^[\w@%+=:,./-]+$/).test(text) ? text : literal(text, platform)
}

// The line typed into a terminal to start Codex: the program, ChoiBuddy's
// own flags, then the first prompt as one plain argument.
export function codexLine(command: string[], prompt: string, platform: NodeJS.Platform = process.platform): string {
  const [program = 'codex', ...flags] = command
  const bare = word(program, platform)
  // PowerShell runs a quoted path only after its call operator.
  const start = platform === 'win32' && bare !== program ? `& ${bare}` : bare

  return [start, ...flags.map(flag => word(flag, platform)), ...(prompt === '' ? [] : [literal(prompt, platform)])].join(' ')
}

function info({ id, title, cwd, run, startedAt, exitCode, exited }: Term): TermInfo {
  return { id, title, cwd, run, startedAt, exitCode, exited }
}

export class Terminals {
  readonly #terms = new Map<string, Term>()
  readonly #now: () => number
  readonly #codex: () => string[] | null
  #pty: PtyModule | null | undefined

  constructor(now: () => number, codex: () => string[] | null) {
    this.#now = now
    this.#codex = codex
  }

  available(): boolean {
    this.#pty ??= loadPty()

    return this.#pty !== null
  }

  list(): TermInfo[] {
    return [...this.#terms.values()].map(info)
  }

  // Opens a shell in `cwd` (the home folder when empty); Claude Code or
  // Codex start in it, so the shell stays when they end.
  open(input: { cwd: string; run: TermRun; cols: number; rows: number; title: string; prompt: string }): TermInfo | string {
    if (!this.available() || this.#pty === null || this.#pty === undefined) return 'no terminal support'

    const cwd = input.cwd === '' ? homedir() : input.cwd

    if (!existsSync(cwd)) return 'no such folder'

    // Finished terminals make room first.
    for (const term of [...this.#terms.values()]) {
      if (this.#terms.size < MAX_TERMS) break
      if (term.exited) this.#terms.delete(term.id)
    }

    if (this.#terms.size >= MAX_TERMS) return 'too many terminals'

    const path = freshPath()
    const id = randomUUID().slice(0, 8)
    const env = path === null ? { ...process.env, [TERM_ENV]: id } : { ...process.env, Path: path, PATH: path, [TERM_ENV]: id }
    const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/bash')
    const args = process.platform === 'win32' ? ['-NoLogo'] : ['-l']
    const pty = this.#pty.spawn(shell, args, { name: 'xterm-256color', cols: clampSize(input.cols, MAX_COLS), rows: clampSize(input.rows, MAX_ROWS), cwd, env })
    const term: Term = { id, title: input.title, cwd, run: input.run, startedAt: this.#now(), exitCode: null, exited: false, pty, backlog: '', listeners: new Set(), paste: false }

    pty.onData(data => {
      const pasteOn = data.lastIndexOf('\x1b[?2004h')
      const pasteOff = data.lastIndexOf('\x1b[?2004l')

      if (pasteOn !== pasteOff) term.paste = pasteOn > pasteOff
      term.backlog = (term.backlog + data).slice(-BACKLOG_CHARS)
      for (const listener of term.listeners) listener.data(data)
    })
    pty.onExit(({ exitCode }) => {
      term.exited = true
      term.exitCode = exitCode
      for (const listener of term.listeners) listener.exit(exitCode)
    })

    if (input.run === 'claude') pty.write('claude\r')
    // Codex takes the first prompt on its command line, after its own flags
    // (ChoiBuddy's, never typed by anyone).
    if (input.run === 'codex') pty.write(`${codexLine(this.#codex() ?? ['codex'], input.prompt)}\r`)

    this.#terms.set(term.id, term)

    return info(term)
  }

  write(id: string, data: string): boolean {
    const term = this.#terms.get(id)

    if (term === undefined || term.exited) return false
    term.pty.write(data)

    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    const term = this.#terms.get(id)

    if (term === undefined || term.exited) return false
    term.pty.resize(clampSize(cols, MAX_COLS), clampSize(rows, MAX_ROWS))

    return true
  }

  // Types a message into the program running in the terminal (Codex) and
  // sends it with Enter: as one paste when the program takes pastes, else on
  // one line. Control characters go, so the message can only be text.
  // `interrupt` presses Esc first, which stops Codex's running turn.
  type(id: string, text: string, interrupt: boolean): boolean {
    const term = this.#terms.get(id)

    if (term === undefined || term.exited) return false

    const plain = text.replace(/\t/g, ' ').replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
    const body = term.paste ? `\x1b[200~${plain}\x1b[201~` : plain.replace(/\n/g, ' ')

    const go = (): void => {
      term.pty.write(body)
      setTimeout(() => {
        if (!term.exited) term.pty.write('\r')
      }, ENTER_AFTER_MS)
    }

    if (!interrupt) {
      go()

      return true
    }

    term.pty.write('\x1b')
    setTimeout(() => {
      if (!term.exited) go()
    }, ESC_SETTLE_MS)

    return true
  }

  // Esc, which stops what the program in the terminal is doing.
  escape(id: string): boolean {
    const term = this.#terms.get(id)

    if (term === undefined || term.exited) return false
    term.pty.write('\x1b')

    return true
  }

  close(id: string): boolean {
    const term = this.#terms.get(id)

    if (term === undefined) return false
    if (!term.exited) term.pty.kill()
    this.#terms.delete(id)

    return true
  }

  // Follows a terminal: what it printed so far, then each new piece.
  follow(id: string, listener: Listener): { backlog: string; exited: boolean; stop: () => void } | null {
    const term = this.#terms.get(id)

    if (term === undefined) return null
    term.listeners.add(listener)

    return { backlog: term.backlog, exited: term.exited, stop: () => term.listeners.delete(listener) }
  }

  closeAll(): void {
    for (const term of this.#terms.values()) if (!term.exited) term.pty.kill()
    this.#terms.clear()
  }
}
