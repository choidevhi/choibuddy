import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PORT } from '../../shared/protocol.ts'
import { arr, type JsonObject, num, objects, parseJsonObject, str } from './json.ts'

export const HOME_DIR = process.env.CHOIBUDDY_HOME ?? join(homedir(), '.choibuddy')

export const CONFIG_PATH = join(HOME_DIR, 'config.json')

export const LOG_PATH = join(HOME_DIR, 'bridge.log')

export const VERSION = '0.5.8'

// A phone or another PC paired with this bridge. Only a hash of its code is
// kept, and each one can be cut off on its own.
export type Device = {
  id: string
  name: string
  hash: string
  createdAt: number
  lastSeen: number | null
}

export type Config = {
  port: number
  // The code this PC's own apps use; it can also create and revoke devices.
  token: string
  pcId: string
  devices: Device[]
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

function readConfigFile(): JsonObject | null {
  try {
    return parseJsonObject(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return null
  }
}

function parseDevices(stored: JsonObject | null): Device[] {
  const devices: Device[] = []

  for (const item of objects(arr(stored, 'devices'))) {
    const id = str(item, 'id')
    const hash = str(item, 'hash')

    if (id === null || hash === null) continue
    devices.push({ id, name: str(item, 'name') ?? '', hash, createdAt: num(item, 'createdAt') ?? 0, lastSeen: num(item, 'lastSeen') })
  }

  return devices
}

export function saveConfig(config: Config): void {
  mkdirSync(HOME_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

// The token guards remote approvals and prompts, so it is long and random and
// lives only in the user's profile.
export function loadConfig(): Config {
  mkdirSync(HOME_DIR, { recursive: true })

  const stored = readConfigFile()
  const token = str(stored, 'token')
  const pcId = str(stored, 'pcId')
  const config: Config = {
    port: num(stored, 'port') ?? DEFAULT_PORT,
    token: token !== null && token.length >= 32 ? token : newToken(),
    pcId: pcId ?? randomBytes(6).toString('hex'),
    devices: parseDevices(stored),
  }

  if (config.token !== token || pcId === null) saveConfig(config)

  return config
}

const LOG_LIMIT = 1_000_000

export function log(line: string): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true })

    let size = 0

    try {
      size = statSync(LOG_PATH).size
    } catch {
      size = 0
    }

    const entry = `${new Date().toISOString()} ${line}\n`

    if (size > LOG_LIMIT) writeFileSync(LOG_PATH, entry)
    else appendFileSync(LOG_PATH, entry)
  } catch {
    // Logging must never take the bridge down.
  }
}
