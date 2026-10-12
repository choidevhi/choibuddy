// Claude Code runs this as a command hook (SessionStart, UserPromptSubmit).
// It starts the bridge when it is down and, with --forward, hands the hook's
// stdin to it. It must print nothing: SessionStart output would be added to
// the model's context.
//
// Codex runs it for all of its hooks with --codex: the hook is handed over
// marked as Codex's, and for an approval the bridge's answer is printed in
// Codex's form once the person decides.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexAnswer } from './codex.ts'
import { loadConfig, log } from './config.ts'
import { parseJsonObject, str } from './json.ts'

const config = loadConfig()
const base = `http://127.0.0.1:${config.port}`
const codex = process.argv.includes('--codex')
const forward = codex || process.argv.includes('--forward')
// An approval is held by the bridge for up to 590 s.
const APPROVAL_WAIT_MS = 595_000

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(400) })

    return res.ok
  } catch {
    return false
  }
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')

  return new Promise(resolve => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 2000)

    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
  })
}

function startBridge(): void {
  const main = join(dirname(fileURLToPath(import.meta.url)), 'main.ts')
  const child = spawn(process.execPath, ['--no-warnings', main], { detached: true, stdio: 'ignore', windowsHide: true })

  child.unref()
  log(`ensure started bridge pid ${child.pid ?? '?'}`)
}

async function waitUp(ms: number): Promise<boolean> {
  const until = Date.now() + ms

  while (Date.now() < until) {
    if (await isUp()) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  return false
}

try {
  const payload = forward ? await readStdin() : ''
  let up = await isUp()

  if (!up) {
    startBridge()
    up = await waitUp(3000)
  }

  const hook = payload.trim() === '' ? null : parseJsonObject(payload)

  if (codex && up && hook !== null) {
    const asking = str(hook, 'hook_event_name') === 'PermissionRequest'
    const res = await fetch(`${base}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The terminal of the app Codex runs in, if any: its session takes the place shown for it.
      body: JSON.stringify({ ...hook, agent: 'codex', choibuddy_term: process.env.CHOIBUDDY_TERM ?? null }),
      signal: AbortSignal.timeout(asking ? APPROVAL_WAIT_MS : 2000),
    })
    const answer = asking ? codexAnswer(parseJsonObject(await res.text())) : ''

    // Written out before the exit below cuts the process short.
    if (answer !== '') await new Promise<void>(resolve => process.stdout.write(answer, () => resolve()))
  } else if (forward && up && payload.trim() !== '') {
    await fetch(`${base}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(2000),
    })
  }
} catch (error) {
  log(`ensure failed: ${error instanceof Error ? error.message : String(error)}`)
}

process.exit(0)
