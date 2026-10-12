// Renders the app's buddy SVGs to transparent PNGs for the Android home-screen
// widget: the black buddy (light theme) into drawable-nodpi, the white one
// (dark theme) into drawable-night-nodpi, under the same names. Run it again
// after changing a pose SVG: node scripts/widget-buddies.mjs (needs Edge).
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const POSES = ['think', 'read', 'edit', 'write', 'bash', 'search', 'web', 'agent', 'todo', 'question', 'plan', 'mcp', 'warning', 'failed', 'done', 'dizzy', 'closed', 'base', 'coffee', 'shrug']
const SIZE = 168
const repo = join(import.meta.dirname, '..')
const res = join(repo, 'android/app/src/main/res')
const targets = [
  { tone: 'black', dir: join(res, 'drawable-nodpi') },
  { tone: 'white', dir: join(res, 'drawable-night-nodpi') },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))
const profile = join(tmpdir(), 'choibuddy-widget-buddies')
rmSync(profile, { recursive: true, force: true })
const port = 9900 + Math.floor(Math.random() * 90)
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${SIZE},${SIZE}`, 'about:blank'], { stdio: 'ignore' })
let targetsList = []
for (let i = 0; i < 50 && targetsList.length === 0; i++) {
  try { targetsList = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page') } catch {}
  await sleep(200)
}
const ws = new WebSocket(targetsList[0].webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })

await send('Emulation.setDeviceMetricsOverride', { width: SIZE, height: SIZE, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
await send('Page.enable')

for (const { tone, dir } of targets) {
  mkdirSync(dir, { recursive: true })

  for (const pose of POSES) {
    const svg = readFileSync(join(repo, 'ui/src/assets/character', tone, `${pose}.svg`), 'utf8').replace(/ width="\d+" height="\d+"/, '')
    const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${SIZE}px;height:${SIZE}px;overflow:visible}</style></head><body>${svg}</body></html>`

    await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` })
    await sleep(250)

    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: 1 } })

    writeFileSync(join(dir, `buddy_${pose}.png`), Buffer.from(shot.result.data, 'base64'))
  }
}

console.log('rendered', POSES.length * targets.length)
ws.close()
edge.kill()
spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
setTimeout(() => process.exit(0), 300)
