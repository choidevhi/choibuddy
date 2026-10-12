import { invoke } from '@tauri-apps/api/core'
import { PAIRING_SCHEME } from '../../shared/protocol.ts'

export type Platform = 'windows' | 'android' | 'web'

export type Connection = {
  baseUrl: string
  token: string
}

function detect(): Platform {
  if (window.ChoiBuddyNative !== undefined) return 'android'
  if ('__TAURI_INTERNALS__' in window) return 'windows'

  return 'web'
}

export const platform: Platform = detect()

export function parseConnection(text: string): Connection | null {
  try {
    const value: { baseUrl?: string; token?: string } | null = JSON.parse(text)

    if (value === null || typeof value.baseUrl !== 'string' || typeof value.token !== 'string') return null

    return { baseUrl: value.baseUrl.replace(/\/+$/, ''), token: value.token }
  } catch {
    return null
  }
}

export function parsePairingLink(link: string): Connection | null {
  const trimmed = link.trim()

  if (!trimmed.startsWith(PAIRING_SCHEME)) return null

  const params = new URLSearchParams(trimmed.slice(trimmed.indexOf('?') + 1))
  const baseUrl = params.get('u')
  const token = params.get('t')

  if (baseUrl === null || token === null || token.length < 16 || !/^https?:\/\/[^/]+:\d+/.test(baseUrl)) return null

  return { baseUrl: baseUrl.replace(/\/+$/, ''), token }
}

const WEB_KEY = 'choibuddy.connection'

// Web (development) reads #choibuddy://pair?... or the last one it saw.
function webConnection(): Connection | null {
  const fromHash = parsePairingLink(decodeURIComponent(window.location.hash.slice(1)))

  try {
    if (fromHash !== null) {
      localStorage.setItem(WEB_KEY, JSON.stringify(fromHash))

      return fromHash
    }

    return parseConnection(localStorage.getItem(WEB_KEY) ?? 'null')
  } catch {
    return fromHash
  }
}

export async function loadConnection(): Promise<Connection | null> {
  switch (platform) {
    case 'android':
      return parseConnection(window.ChoiBuddyNative?.getConfig() ?? 'null')
    case 'windows':
      return parseConnection(await invoke<string>('connection'))
    case 'web':
      return webConnection()
  }
}

export const windowsShell = {
  setAlwaysOnTop: (on: boolean): Promise<void> => invoke('set_always_on_top', { on }),
  hide: (): Promise<void> => invoke('hide_window'),
  minimize: (): Promise<void> => invoke('minimize_window'),
  autostart: (): Promise<boolean> => invoke<boolean>('autostart_enabled'),
  setAutostart: (on: boolean): Promise<void> => invoke('set_autostart', { on }),
  startBridge: (): Promise<boolean> => invoke<boolean>('start_bridge'),
  installBridge: (): Promise<boolean> => invoke<boolean>('install_bridge'),
  tailscaleState: (): Promise<'installed' | 'missing'> => invoke<'installed' | 'missing'>('tailscale_state'),
  installTailscale: (): Promise<boolean> => invoke<boolean>('install_tailscale'),
  openTailscale: (): Promise<boolean> => invoke<boolean>('open_tailscale'),
  reveal: (): Promise<void> => invoke('reveal_window'),
  showMain: (): Promise<void> => invoke('show_main'),
  setFloat: (on: boolean): Promise<void> => invoke('set_float', { on }),
  floatLayout: (width: number, height: number): Promise<void> => invoke('float_layout', { width, height }),
  resetFloat: (): Promise<void> => invoke('reset_float'),
  setTrayTexts: (open: string, float: string, reset: string, quit: string): Promise<void> => invoke('set_tray_texts', { open, float, reset, quit }),
  // The floating buddy's right-click menu, in the app's language.
  floatMenu: (texts: { open: string; sound: string; reset: string; hide: string; quit: string }): Promise<void> => invoke('float_menu', { texts }),
}

export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(`choibuddy.${key}`)

    return allowed.find(value => value === stored) ?? fallback
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`choibuddy.${key}`, value)
  } catch {
    // Preferences are a convenience; the UI works without storage.
  }
}
