// Puts node-pty (the in-app terminal's native part) into
// windows/src-tauri/runtime/pty/, so the Windows app ships it: its installer
// copies it beside the bridge. Taken from node_modules, the package and its
// Windows build together; debug symbols stay out.
// usage: node scripts/vendor-pty.mjs
import { cpSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, 'windows', 'src-tauri', 'runtime', 'pty', 'node_modules', '@lydell')
const PACKAGES = ['node-pty', 'node-pty-win32-x64']

// The folder holding @lydell/node-pty and its platform package (pnpm keeps
// them side by side).
const scope = dirname(realpathSync(dirname(createRequire(join(ROOT, 'package.json')).resolve('@lydell/node-pty'))))

for (const name of PACKAGES) {
  if (!existsSync(join(scope, name))) throw new Error(`@lydell/${name} is missing: run corepack pnpm install`)
}

rmSync(join(ROOT, 'windows', 'src-tauri', 'runtime', 'pty'), { recursive: true, force: true })

for (const name of PACKAGES) {
  cpSync(realpathSync(join(scope, name)), join(OUT, name), { recursive: true, filter: source => !source.endsWith('.pdb') })
}

console.log(`node-pty → ${OUT}`)
