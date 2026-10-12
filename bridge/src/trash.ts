// Deleted conversations wait here for a while before they are gone for good.
import { cpSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const KEEP_MS = 30 * 24 * 60 * 60_000

// Moves a file or folder into `dir`, copying when it sits on another drive.
export function moveInto(path: string, dir: string): void {
  const target = join(dir, basename(path))

  try {
    renameSync(path, target)
  } catch {
    cpSync(path, target, { recursive: true })
    rmSync(path, { recursive: true, force: true })
  }
}

// Empties trash entries older than 30 days.
export function purgeTrash(dir: string, now: number): number {
  let removed = 0
  let names: string[] = []

  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }

  for (const name of names) {
    const path = join(dir, name)

    try {
      if (now - statSync(path).mtimeMs > KEEP_MS) {
        rmSync(path, { recursive: true, force: true })
        removed += 1
      }
    } catch {
      // Gone already.
    }
  }

  return removed
}
