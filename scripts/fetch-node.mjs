// Puts the Node.js runtime the Windows app ships with into
// windows/src-tauri/runtime/, so people need no Node of their own: the app
// runs the bridge, its installer and Claude Code's hooks with it.
// The download is checked against the SHA-256 pinned here (from the
// release's SHASUMS256.txt); a mismatch stops the build.
// usage: node scripts/fetch-node.mjs
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = '24.21.0'
const ZIP = `node-v${VERSION}-win-x64`
const ZIP_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
const OUT = join(import.meta.dirname, '..', 'windows', 'src-tauri', 'runtime')
const STAMP = join(OUT, 'VERSION')

if (existsSync(join(OUT, 'node.exe')) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === VERSION) {
  console.log(`node ${VERSION} already in ${OUT}`)
  process.exit(0)
}

const res = await fetch(`https://nodejs.org/dist/v${VERSION}/${ZIP}.zip`)

if (!res.ok) throw new Error(`download failed: ${res.status}`)

const zip = Buffer.from(await res.arrayBuffer())
const sha = createHash('sha256').update(zip).digest('hex')

if (sha !== ZIP_SHA256) throw new Error(`${ZIP}.zip SHA-256 ${sha} is not the pinned ${ZIP_SHA256}`)

const work = mkdtempSync(join(tmpdir(), 'choibuddy-node-'))

try {
  writeFileSync(join(work, 'node.zip'), zip)

  // Windows' own tar reads zip files (a Git Bash tar earlier on the PATH
  // does not, and takes "C:" for a host name).
  const tar = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', 'node.zip', `${ZIP}/node.exe`, `${ZIP}/LICENSE`], { cwd: work, stdio: 'inherit' })

  if (tar.status !== 0) throw new Error('could not unpack the Node zip')

  mkdirSync(OUT, { recursive: true })
  copyFileSync(join(work, ZIP, 'node.exe'), join(OUT, 'node.exe'))
  copyFileSync(join(work, ZIP, 'LICENSE'), join(OUT, 'LICENSE'))
  writeFileSync(STAMP, `${VERSION}\n`)
  console.log(`node ${VERSION} → ${OUT}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
