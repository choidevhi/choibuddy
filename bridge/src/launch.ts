// Opens a new Claude Code session on this PC in a terminal window, for the
// "new session" button in the widget and on the phone. The program and its
// arguments go to spawn as a list (no shell), and the folder must exist, so
// nothing typed on a device is ever run as a command line.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type Terminal = {
  name: string
  program: string
  // `command` runs in the new terminal; empty opens the terminal's own shell.
  args: (cwd: string, command: string[]) => string[]
}

// Which terminal to use, best first.
// Windows: WezTerm, Windows Terminal, then plain cmd.
// macOS: WezTerm, then Terminal.app. Terminal is driven with AppleScript; the
// folder and the command go in as arguments and `quoted form of` quotes each
// for the shell, so none of them is ever read as code. The first time, macOS
// asks to let ChoiBuddy control Terminal.
export function pickTerminal(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, platform: NodeJS.Platform = process.platform): Terminal {
  if (platform === 'darwin') {
    const wezterm = '/Applications/WezTerm.app/Contents/MacOS/wezterm'

    if (exists(wezterm)) return { name: 'WezTerm', program: wezterm, args: (cwd, command) => ['start', '--cwd', cwd, ...(command.length > 0 ? ['--', ...command] : [])] }

    const script = [
      'on run argv',
      'set shellLine to "cd " & quoted form of (item 1 of argv)',
      'if (count of argv) > 1 then set shellLine to shellLine & " &&"',
      'repeat with i from 2 to count of argv',
      'set shellLine to shellLine & " " & quoted form of (item i of argv)',
      'end repeat',
      'tell application "Terminal"',
      'activate',
      'do script shellLine',
      'end tell',
      'end run',
    ]

    return { name: 'Terminal', program: '/usr/bin/osascript', args: (cwd, command) => [...script.flatMap(line => ['-e', line]), cwd, ...command] }
  }

  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const wezterm = join(programFiles, 'WezTerm', 'wezterm.exe')

  if (exists(wezterm)) return { name: 'WezTerm', program: wezterm, args: (cwd, command) => ['start', '--cwd', cwd, ...(command.length > 0 ? ['--', ...command] : [])] }

  const windowsApps = join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe')

  if (env.LOCALAPPDATA !== undefined && exists(windowsApps)) return { name: 'Windows Terminal', program: windowsApps, args: (cwd, command) => ['-d', cwd, ...command] }

  return { name: 'cmd', program: env.ComSpec ?? 'cmd.exe', args: (cwd, command) => ['/c', 'start', '/D', cwd, ...command] }
}

export function isFolder(path: string): boolean {
  try {
    return path !== '' && statSync(path).isDirectory()
  } catch {
    return false
  }
}

export type Opened = { ok: true; terminal: string } | { ok: false; error: string }

export function openSession(cwd: string): Opened {
  return openTerminal(cwd, ['claude'])
}

// A terminal window in `cwd` running `command` (empty: just a shell).
export function openTerminal(cwd: string, command: string[] = []): Opened {
  if (!isFolder(cwd)) return { ok: false, error: 'no such folder' }

  const terminal = pickTerminal(process.env, existsSync)

  try {
    const child = spawn(terminal.program, terminal.args(cwd, command), { cwd, detached: true, stdio: 'ignore', windowsHide: false })

    child.on('error', () => undefined)
    child.unref()

    return { ok: true, terminal: terminal.name }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// A prompt to hand to the session that opens next in `cwd`, once its mod polls.
export type LaunchPrompt = {
  cwd: string
  text: string
  at: number
}

const LAUNCH_WAIT_MS = 3 * 60_000

// Takes the prompt waiting for a session that started in `cwd` after it was
// asked for; prompts nobody picked up in time are dropped.
export function claimLaunchPrompt(waiting: LaunchPrompt[], cwd: string, startedAt: number, now: number): string | null {
  for (let index = waiting.length - 1; index >= 0; index -= 1) {
    const item = waiting[index]

    if (item === undefined) continue

    if (now - item.at > LAUNCH_WAIT_MS) {
      waiting.splice(index, 1)
      continue
    }

    if (item.cwd.toLowerCase() === cwd.toLowerCase() && startedAt >= item.at - 1000) {
      waiting.splice(index, 1)

      return item.text
    }
  }

  return null
}
