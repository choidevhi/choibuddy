// Who is on this PC's tailnet, read from `tailscale status --json`, and
// whether an address there is one of the person's own devices: signed in
// with the same Tailscale account, not a device shared in from someone else
// and not a tagged server. Tailscale vouches for the address (WireGuard keys),
// so the bridge can trust "this request came from my phone" without a code.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { arr, asObject, bool, type JsonObject, num, obj, parseJsonObject, str, strings } from './json.ts'

export type Peer = {
  ip: string
  name: string
  os: string
  online: boolean
  // Same Tailscale account, not shared in, not tagged.
  mine: boolean
}

export type TailnetView = {
  selfIps: string[]
  peers: Peer[]
}

const EMPTY: TailnetView = { selfIps: [], peers: [] }
const CACHE_MS = 15_000
const STATUS_TIMEOUT_MS = 3_000

function ipv4(ips: string[]): string | null {
  return ips.find(ip => ip.includes('.')) ?? null
}

export function parseStatus(status: JsonObject | null): TailnetView {
  const self = obj(status, 'Self')
  const owner = num(self, 'UserID')
  const peers: Peer[] = []

  for (const value of Object.values(obj(status, 'Peer') ?? {})) {
    const peer = asObject(value)
    const ip = ipv4(strings(arr(peer, 'TailscaleIPs')))

    if (peer === null || ip === null) continue

    peers.push({
      ip,
      name: str(peer, 'HostName') ?? str(peer, 'DNSName') ?? ip,
      os: str(peer, 'OS') ?? '',
      online: bool(peer, 'Online') ?? false,
      mine: owner !== null && num(peer, 'UserID') === owner && arr(peer, 'Tags').length === 0 && bool(peer, 'ShareeNode') !== true,
    })
  }

  return { selfIps: strings(arr(self, 'TailscaleIPs')), peers }
}

// "::ffff:100.1.2.3" (IPv4 on an IPv6 socket) → "100.1.2.3".
export function plainIp(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/, '')
}

// The name of the person's own device at `ip` (this PC included), or null.
export function ownDevice(view: TailnetView, ip: string): string | null {
  if (view.selfIps.includes(ip)) return 'self'

  const peer = view.peers.find(item => item.ip === ip)

  return peer?.mine === true ? peer.name : null
}

function cli(): string {
  if (process.platform === 'win32') {
    const installed = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')

    if (existsSync(installed)) return installed
  }

  if (process.platform === 'darwin' && existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale')) return '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

  return 'tailscale'
}

export function readStatus(): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cli(), ['status', '--json'], { timeout: STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? stdout : null)
    })
  })
}

export class Tailnet {
  readonly #read: () => Promise<string | null>
  readonly #now: () => number
  #cached: { at: number; view: TailnetView } | null = null

  constructor(read: () => Promise<string | null>, now: () => number) {
    this.#read = read
    this.#now = now
  }

  async view(): Promise<TailnetView> {
    if (this.#cached !== null && this.#now() - this.#cached.at < CACHE_MS) return this.#cached.view

    const text = await this.#read()
    const view = text === null ? EMPTY : parseStatus(parseJsonObject(text))

    this.#cached = { at: this.#now(), view }

    return view
  }
}
