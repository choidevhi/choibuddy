// Installs the bridge into ~/.choibuddy/app, with a Node of its own to run
// on, wires Claude Code's hooks to it in ~/.claude/settings.json (backed up
// first) and installs the companion mod (usage figures, prompts from the
// widget) into ~/.claude/local-mods.
// `--uninstall` removes the hooks and the mod again and stops the bridge.
// `--when-idle` does nothing (exit code 3) while an approval request waits,
// so an automatic update never drops one. Auto Accept, which lives only in
// the running bridge, is turned on again after the restart.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_PATH, HOME_DIR, loadConfig } from './config.ts'
import { arr, asObject, type JsonObject, num, objects, parseJsonObject, str } from './json.ts'
import { withOurHooks, withoutOurHooks } from './settings-hooks.ts'

const SETTINGS_PATH = process.env.CHOIBUDDY_SETTINGS ?? join(homedir(), '.claude', 'settings.json')
const APP_DIR = join(HOME_DIR, 'app')
const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODS_DIR = join(homedir(), '.claude', 'local-mods')
const MOD_NAME = 'choibuddy'
const MARKETPLACE = 'local-mods'

function copyApp(): string {
  const bridgeOut = join(APP_DIR, 'bridge', 'src')
  const sharedOut = join(APP_DIR, 'shared')

  mkdirSync(bridgeOut, { recursive: true })
  mkdirSync(sharedOut, { recursive: true })

  for (const file of readdirSync(join(SOURCE_ROOT, 'bridge', 'src'))) {
    if (file.endsWith('.ts')) copyFileSync(join(SOURCE_ROOT, 'bridge', 'src', file), join(bridgeOut, file))
  }

  copyFileSync(join(SOURCE_ROOT, 'shared', 'protocol.ts'), join(sharedOut, 'protocol.ts'))

  return join(bridgeOut, 'ensure.ts')
}

function sameFile(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false

  const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

  return digest(a) === digest(b)
}

// The bridge and the hooks run on a Node of their own: a copy of the one
// running this installer (the Node the Windows app ships with, or yours when
// installing from a clone). So nobody needs Node on the PATH, and updating or
// removing another Node can't break Claude Code's hooks.
function copyNode(): string {
  const dir = join(APP_DIR, 'node')
  const target = join(dir, basename(process.execPath))

  mkdirSync(dir, { recursive: true })

  // Copies set aside last time while they were still running.
  for (const file of readdirSync(dir)) {
    if (file.startsWith(`${basename(target)}.old-`)) rmSync(join(dir, file), { force: true })
  }

  if (process.execPath === target || (existsSync(target) && sameFile(target, process.execPath))) return target

  // A running node.exe can't be overwritten on Windows, but it can be moved.
  if (existsSync(target)) renameSync(target, `${target}.old-${Date.now()}`)
  copyFileSync(process.execPath, target)

  return target
}

// The in-app terminal's native part (node-pty), beside the bridge in app/pty:
// from the Windows app's resources, or from node_modules in a clone. The
// same version stays in place, since a running bridge may have it loaded; a
// new one replaces it, the old folder set aside first (a folder still in use
// stays as it is, and still works).
function copyPty(): boolean {
  const target = join(APP_DIR, 'pty')
  const out = join(target, 'node_modules', '@lydell')
  const packaged = join(SOURCE_ROOT, 'runtime', 'pty', 'node_modules', '@lydell')
  const from = existsSync(packaged) ? packaged : ptyInNodeModules()

  for (const entry of readdirSync(APP_DIR)) {
    if (entry.startsWith('pty.old-')) rmSync(join(APP_DIR, entry), { recursive: true, force: true })
  }

  if (from === null) return false
  if (ptyVersion(out) !== null && ptyVersion(out) === ptyVersion(from)) return true

  if (existsSync(target)) {
    try {
      renameSync(target, `${target}.old-${Date.now()}`)
    } catch {
      return ptyVersion(out) !== null
    }
  }

  for (const name of ['node-pty', 'node-pty-win32-x64']) {
    cpSync(realpathSync(join(from, name)), join(out, name), { recursive: true, filter: source => !source.endsWith('.pdb') })
  }

  return true
}

// The folder holding @lydell/node-pty and its platform package, in a clone.
function ptyInNodeModules(): string | null {
  try {
    return dirname(realpathSync(dirname(createRequire(join(SOURCE_ROOT, 'package.json')).resolve('@lydell/node-pty'))))
  } catch {
    return null
  }
}

function ptyVersion(scope: string): string | null {
  const manifest = join(scope, 'node-pty-win32-x64', 'package.json')

  return existsSync(manifest) ? str(parseJsonObject(readFileSync(manifest, 'utf8')), 'version') : null
}

function claude(args: string[]): boolean {
  const result = spawnSync('claude', args, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })

  return result.status === 0
}

// The mod lives in a folder marketplace; the install is updated after each
// copy, so open sessions pick it up with /reload-plugins.
function installMod(): boolean {
  const target = join(MODS_DIR, MOD_NAME)
  const manifestPath = join(MODS_DIR, '.claude-plugin', 'marketplace.json')

  rmSync(target, { recursive: true, force: true })
  cpSync(join(SOURCE_ROOT, 'mod'), target, {
    recursive: true,
    filter: source => !source.includes(join('mod', 'test')) && !source.includes(join('.claude-plugin', 'types')),
  })

  const manifest = existsSync(manifestPath) ? parseJsonObject(readFileSync(manifestPath, 'utf8')) : null
  const plugins = objects(arr(manifest, 'plugins')).filter(plugin => str(plugin, 'name') !== MOD_NAME)
  const next: JsonObject = {
    name: str(manifest, 'name') ?? MARKETPLACE,
    owner: asObject(manifest?.owner) ?? { name: 'choidevhi' },
    plugins: [...plugins, { name: MOD_NAME, source: `./${MOD_NAME}`, description: 'ChoiBuddy: 사용량 보고와 원격 프롬프트' }],
  }

  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)

  if (!claude(['plugin', 'marketplace', 'update', MARKETPLACE])) claude(['plugin', 'marketplace', 'add', MODS_DIR])

  if (!claude(['plugin', 'install', `${MOD_NAME}@${MARKETPLACE}`, '--scope', 'user'])) return false

  // An install made by an older Claude Code points at a copy of the mod
  // (plugins/cache/...), which open sessions' /reload-plugins loads again:
  // update brings it to this version (or says it reads the folder itself).
  return claude(['plugin', 'update', `${MOD_NAME}@${MARKETPLACE}`])
}

function readSettings(): JsonObject {
  if (!existsSync(SETTINGS_PATH)) return {}

  const parsed = parseJsonObject(readFileSync(SETTINGS_PATH, 'utf8'))

  if (parsed === null) throw new Error(`${SETTINGS_PATH} 을(를) JSON으로 읽지 못했어요. 손대지 않고 멈춥니다.`)

  return parsed
}

function writeSettings(settings: JsonObject): void {
  if (existsSync(SETTINGS_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')

    copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.choibuddy-backup-${stamp}`)
  }

  mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`)
}

async function stopBridge(port: number, token: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1000),
    })
    await new Promise(resolve => setTimeout(resolve, 300))
  } catch {
    // Not running.
  }
}

// The running bridge's state that a restart would lose: waiting approval
// requests and Auto Accept. Null when no bridge answers.
async function runningState(port: number, token: string): Promise<{ pending: number; autoAcceptUntil: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) })
    const snapshot = parseJsonObject(await res.text())

    return { pending: objects(arr(snapshot, 'pending')).length, autoAcceptUntil: num(asObject(snapshot?.server), 'autoAcceptUntil') ?? 0 }
  } catch {
    return null
  }
}

// Turns Auto Accept back on for what was left of it (or until turned off).
async function restoreAutoAccept(port: number, token: string, until: number): Promise<boolean> {
  if (until <= Date.now()) return false

  const minutes = until >= Number.MAX_SAFE_INTEGER ? -1 : Math.ceil((until - Date.now()) / 60_000)
  const res = await fetch(`http://127.0.0.1:${port}/api/auto-accept`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes }),
  }).catch(() => null)

  return res?.ok === true
}

async function main(): Promise<void> {
  const config = loadConfig()
  const settings = readSettings()
  const hooks = asObject(settings.hooks) ?? {}
  const before = await runningState(config.port, config.token)

  if (process.argv.includes('--when-idle') && before !== null && before.pending > 0) {
    console.log(`승인 요청 ${before.pending}개가 기다리고 있어요. 끝나면 다시 설치해요.`)
    process.exit(3)
  }

  await stopBridge(config.port, config.token)

  if (process.argv.includes('--uninstall')) {
    const rest = withoutOurHooks(hooks)

    writeSettings({ ...settings, hooks: rest })
    claude(['plugin', 'uninstall', `${MOD_NAME}@${MARKETPLACE}`, '--scope', 'user'])
    console.log('ChoiBuddy 훅과 mod를 지웠고 브리지를 멈췄어요.')

    return
  }

  const ensurePath = copyApp()
  const nodePath = copyNode()
  const ptyCopied = copyPty()

  writeSettings({ ...settings, hooks: withOurHooks(hooks, config.port, ensurePath, nodePath) })

  const modInstalled = installMod()

  const started = spawnSync(nodePath, ['--no-warnings', ensurePath], { stdio: 'inherit' })
  const health = await fetch(`http://127.0.0.1:${config.port}/api/health`).then(
    res => res.ok,
    () => false,
  )
  const snapshot = health
    ? parseJsonObject(await fetch(`http://127.0.0.1:${config.port}/api/snapshot`, { headers: { Authorization: `Bearer ${config.token}` } }).then(res => res.text()))
    : null
  const tailnetUrl = str(asObject(snapshot?.server), 'tailnetUrl')
  const autoAccept = health && before !== null ? await restoreAutoAccept(config.port, config.token, before.autoAcceptUntil) : false

  console.log(`설치 위치: ${APP_DIR} (Node ${process.version})`)
  console.log(`앱 안 터미널: ${ptyCopied ? '준비됨' : 'node-pty를 찾지 못해 꺼져 있어요'}`)
  console.log(`설정 파일: ${SETTINGS_PATH} (백업 후 훅 추가)`)
  console.log(`토큰 파일: ${CONFIG_PATH}`)
  console.log(`브리지: ${health ? '실행 중' : `시작 실패 (종료 코드 ${started.status})`}${autoAccept ? ' (Auto Accept 다시 켬)' : ''}`)
  console.log(`사용량·프롬프트 mod: ${modInstalled ? `설치됨 (${join(MODS_DIR, MOD_NAME)}), 열려 있는 세션은 /reload-plugins` : '설치 실패: claude plugin install로 직접 설치해 주세요'}`)
  // The pairing link carries the token, so it is shown as a QR in the app
  // (＋ tab) rather than printed into terminal scrollback.
  console.log(`휴대폰 연결: ${tailnetUrl === null ? 'Tailscale이 꺼져 있어요' : `ChoiBuddy 창의 ＋ 탭에서 QR을 찍어 주세요 (${tailnetUrl})`}`)
}

await main()
