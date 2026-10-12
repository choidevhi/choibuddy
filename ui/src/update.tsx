import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useBackLayer } from './back.ts'
import { showToast } from './confirm.tsx'
import { useI18n } from './i18n.ts'
import { platform } from './platform.ts'

// The version this build of the screens belongs to (package.json).
export const APP_VERSION = __APP_VERSION__

const REPO = 'choidevhi/choibuddy'
const CHECK_MS = 6 * 60 * 60_000
const KEY = 'choibuddy.update'

export type Release = {
  version: string
  // The release page, with what changed.
  page: string
  exe: string | null
  apk: string | null
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

    for (const asset of Array.isArray(body.assets) ? body.assets : []) {
      if (typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') continue
      if (asset.name.endsWith('_x64-setup.exe')) exe = asset.browser_download_url
      if (asset.name.endsWith('.apk')) apk = asset.browser_download_url
    }

    return { version: body.tag_name.replace(/^v/, ''), page: body.html_url, exe, apk }
  } catch {
    return null
  }
}

// The last answer, so several starts in a row ask GitHub only once.
function readCached(): { at: number; release: Release | null } | null {
  try {
    const cached: { at?: number; release?: Release | null } = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? {}

    return typeof cached.at === 'number' && cached.release !== undefined ? { at: cached.at, release: cached.release } : null
  } catch {
    return null
  }
}

// A newer release than this app, checked at start and every 6 hours.
export function useUpdate(): Release | null {
  const [latest, setLatest] = useState<Release | null>(() => readCached()?.release ?? null)

  useEffect(() => {
    if (platform === 'web') return

    const check = (): void => {
      const cached = readCached()

      if (cached !== null && Date.now() - cached.at < CHECK_MS) return

      void fetchLatest().then(release => {
        try {
          localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), release }))
        } catch {
          // Asking again next time is fine.
        }
        setLatest(release)
      })
    }

    check()

    const timer = window.setInterval(check, CHECK_MS)

    return () => window.clearInterval(timer)
  }, [])

  return latest !== null && isNewer(latest.version, APP_VERSION) ? latest : null
}

// Windows downloads and installs it, then starts again; the phone opens the
// APK's download, which Android then offers to install. An error comes back as text.
export async function applyUpdate(release: Release): Promise<string | null> {
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
    if (error !== null || platform !== 'windows') {
      setBusy(false)
      onClose()
    }
  }

  return (
    <div className="sheet-backdrop" onClick={() => (busy ? undefined : onClose())}>
      <div className="sheet confirm-sheet" role="dialog" aria-modal="true" aria-label={t('update.title', { v: release.version })} onClick={event => event.stopPropagation()}>
        <div className="confirm-body">
          <div className="sheet-title">{t('update.title', { v: release.version })}</div>
          <div className="confirm-hint">{platform === 'windows' ? t('update.hintWindows') : t('update.hintPhone')}</div>
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
