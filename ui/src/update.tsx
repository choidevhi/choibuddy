import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useBackLayer } from './back.ts'
import { showToast } from './confirm.tsx'
import { useI18n } from './i18n.ts'
import { isMac, platform } from './platform.ts'

// The version this build of the screens belongs to (package.json).
export const APP_VERSION = __APP_VERSION__

const REPO = 'choidevhi/choibuddy'
const CHECK_MS = 6 * 60 * 60_000
// Back in the app after this long, it asks again: a phone keeps the app
// running for days without starting it anew.
const RESUME_MS = 30 * 60_000
const KEY = 'choibuddy.update'

export type Release = {
  version: string
  // The release page, with what changed.
  page: string
  exe: string | null
  apk: string | null
  // A macOS build in the release; without one a Mac is not told to update.
  dmg?: string | null
}

// "0.6.10" is newer than "0.6.9"; anything unreadable is not newer.
export function isNewer(candidate: string, current: string): boolean {
  const parts = (text: string): number[] | null => {
    const numbers = text.replace(/^v/, '').split('.').map(Number)

    return numbers.every(Number.isInteger) ? numbers : null
  }
  const a = parts(candidate)
  const b = parts(current)

  if (a === null || b === null) return false

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)

    if (difference !== 0) return difference > 0
  }

  return false
}

// GitHub's answer for the latest release, read field by field.
type GithubRelease = { tag_name?: string; html_url?: string; assets?: Array<{ name?: string; browser_download_url?: string }> }

async function fetchLatest(): Promise<Release | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })

    if (!res.ok) return null

    const body: GithubRelease = await res.json()

    if (typeof body.tag_name !== 'string' || typeof body.html_url !== 'string') return null

    let exe: string | null = null
    let apk: string | null = null
    let dmg: string | null = null

    for (const asset of Array.isArray(body.assets) ? body.assets : []) {
      if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue
      if (asset.name.endsWith('_x64-setup.exe')) exe = asset.browser_download_url
      if (asset.name.endsWith('.apk')) apk = asset.browser_download_url
      if (asset.name.endsWith('.dmg')) dmg = asset.browser_download_url
    }

    return { version: body.tag_name.replace(/^v/, ''), page: body.html_url, exe, apk, dmg }
  } catch {
    return null
  }
}

// The last answer, shown at once while GitHub is asked again.
function readCached(): { at: number; release: Release | null } | null {
  try {
    const cached: { at?: number; release?: Release | null } = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? {}

    return typeof cached.at === 'number' && cached.release !== undefined ? { at: cached.at, release: cached.release } : null
  } catch {
    return null
  }
}

export type UpdateState = {
  // A newer release than this app, or null.
  release: Release | null
  // When GitHub last answered (0: not yet).
  checkedAt: number
  checking: boolean
  // Asks GitHub now; false when it could not be reached.
  check: () => Promise<boolean>
}

// A newer release than this app: asked at every start, every 6 hours, when
// the app comes back after a while, and from the settings button.
export function useUpdate(): UpdateState {
  const [latest, setLatest] = useState<Release | null>(() => readCached()?.release ?? null)
  const [checkedAt, setCheckedAt] = useState(() => readCached()?.at ?? 0)
  const [checking, setChecking] = useState(false)
  const lastAt = useRef(0)

  const check = useCallback(async (): Promise<boolean> => {
    if (platform === 'web') return false

    setChecking(true)

    const release = await fetchLatest()

    setChecking(false)

    // Offline or refused: what was known stays.
    if (release === null) return false

    const at = Date.now()

    try {
      localStorage.setItem(KEY, JSON.stringify({ at, release }))
    } catch {
      // Shown from memory until the next start.
    }
    lastAt.current = at
    setLatest(release)
    setCheckedAt(at)

    return true
  }, [])

  useEffect(() => {
    if (platform === 'web') return

    void check()

    const timer = window.setInterval(() => void check(), CHECK_MS)

    const onBack = (): void => {
      if (document.visibilityState === 'visible' && Date.now() - lastAt.current >= RESUME_MS) void check()
    }

    document.addEventListener('visibilitychange', onBack)
    window.addEventListener('focus', onBack)

    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onBack)
      window.removeEventListener('focus', onBack)
    }
  }, [])

  const newer = latest !== null && isNewer(latest.version, APP_VERSION) ? latest : null

  // A Mac hears only of releases that carry a .dmg.
  return { release: isMac && (newer?.dmg ?? null) === null ? null : newer, checkedAt, checking, check }
}

// Windows downloads and installs it, then starts again; the phone opens the
// APK's download, which Android then offers to install. An error comes back as text.
export async function applyUpdate(release: Release): Promise<string | null> {
  // macOS: the release page, to pick the .dmg for this Mac and drag it into Applications.
  if (isMac) {
    openPage(release.page)

    return null
  }

  if (platform === 'windows') {
    if (release.exe === null) return 'no installer'

    return invoke('install_update', { url: release.exe }).then(
      () => null,
      (error: Error | string) => String(error),
    )
  }

  openPage(release.apk ?? release.page)

  return null
}

export function openPage(url: string): void {
  if (platform === 'windows') {
    void invoke('open_release_page', { url })

    return
  }

  if (window.ChoiBuddyNative?.openUrl?.(url) === true) return
  window.open(url, '_blank', 'noopener')
}

// Asks before updating: on Windows the app downloads, installs and starts
// again (the Claude Code connection follows on its own); on the phone the
// APK downloads and Android asks to install it.
export function UpdateSheet({ release, onClose }: { release: Release; onClose: () => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)

  useBackLayer(!busy, onClose)

  const start = async (): Promise<void> => {
    setBusy(true)

    const error = await applyUpdate(release)

    if (error !== null) showToast(`${t('update.failed')}: ${error}`)
    // Windows quits for the installer; nothing more happens here.
    if (error !== null || platform !== 'windows' || isMac) {
      setBusy(false)
      onClose()
    }
  }

  return (
    <div className="sheet-backdrop" onClick={() => (busy ? undefined : onClose())}>
      <div className="sheet confirm-sheet" role="dialog" aria-modal="true" aria-label={t('update.title', { v: release.version })} onClick={event => event.stopPropagation()}>
        <div className="confirm-body">
          <div className="sheet-title">{t('update.title', { v: release.version })}</div>
          <div className="confirm-hint">{isMac ? t('update.hintMac') : platform === 'windows' ? t('update.hintWindows') : t('update.hintPhone')}</div>
          <button type="button" className="link-btn update-notes" onClick={() => openPage(release.page)}>
            {t('update.notes')}
          </button>
        </div>
        <footer className="sheet-actions">
          <button type="button" className="btn btn--deny" disabled={busy} onClick={onClose}>
            {t('action.cancel')}
          </button>
          <button type="button" className="btn btn--allow" disabled={busy} onClick={() => void start()}>
            {busy ? t('update.downloading') : t('update.confirm')}
          </button>
        </footer>
      </div>
    </div>
  )
}
