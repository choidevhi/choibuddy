// Puts the Node.js runtime the desktop app ships with into
// windows/src-tauri/runtime/ (node.exe on Windows, node on macOS for this
// Mac's CPU), so people need no Node of their own: the app runs the bridge,
// its installer and Claude Code's hooks with it.
// The download is checked against the SHA-256 pinned here (from the
// release's SHASUMS256.txt); a mismatch stops the build.
// usage: node scripts/fetch-node.mjs
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = '24.21.0'
// From the release's SHASUMS256.txt.
const BUILDS = {
  'win32-x64': { name: `node-v${VERSION}-win-x64`, ext: 'zip', sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541' },
  'darwin-arm64': { name: `node-v${VERSION}-darwin-arm64`, ext: 'tar.gz', sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057' },
  'darwin-x64': { name: `node-v${VERSION}-darwin-x64`, ext: 'tar.gz', sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097' },
}
const build = BUILDS[`${process.platform}-${process.arch}`]

if (build === undefined) throw new Error(`no pinned Node build for ${process.platform}-${process.arch}`)

const windows = process.platform === 'win32'
const NODE = windows ? 'node.exe' : 'node'
const OUT = join(import.meta.dirname, '..', 'windows', 'src-tauri', 'runtime')
const STAMP = join(OUT, 'VERSION')

if (existsSync(join(OUT, NODE)) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === VERSION) {
  console.log(`node ${VERSION} already in ${OUT}`)
  process.exit(0)
}

const res = await fetch(`https://nodejs.org/dist/v${VERSION}/${build.name}.${build.ext}`)

if (!res.ok) throw new Error(`download failed: ${res.status}`)

const archive = Buffer.from(await res.arrayBuffer())
const sha = createHash('sha256').update(archive).digest('hex')

if (sha !== build.sha256) throw new Error(`${build.name}.${build.ext} SHA-256 ${sha} is not the pinned ${build.sha256}`)

const work = mkdtempSync(join(tmpdir(), 'choibuddy-node-'))

try {
  const file = `node.${build.ext}`
  const inside = windows ? `${build.name}/node.exe` : `${build.name}/bin/node`

  writeFileSync(join(work, file), archive)

  // Windows' own tar reads zip files (a Git Bash tar earlier on the PATH
  // does not, and takes "C:" for a host name); macOS's tar reads the tarball.
  const tarPath = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  const tar = spawnSync(tarPath, ['-xf', file, inside, `${build.name}/LICENSE`], { cwd: work, stdio: 'inherit' })

  if (tar.status !== 0) throw new Error('could not unpack the Node archive')

  mkdirSync(OUT, { recursive: true })
  copyFileSync(join(work, inside), join(OUT, NODE))
  if (!windows) chmodSync(join(OUT, NODE), 0o755)
  copyFileSync(join(work, build.name, 'LICENSE'), join(OUT, 'LICENSE'))
  writeFileSync(STAMP, `${VERSION}\n`)
  console.log(`node ${VERSION} → ${OUT}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
