import { useEffect, useRef, useState } from 'react'
import { useI18n } from './i18n.ts'
import { ImageIcon, SpinnerIcon } from './icons.tsx'
import { fetchImageBlob } from './live.ts'
import { type Connection, platform } from './platform.ts'

// Object URLs of pictures already fetched, least recently used first; past
// the limit the oldest are let go.
const CACHE_LIMIT = 150
const cache = new Map<string, Promise<string | null>>()

export function imageObjectUrl(connection: Connection, id: string): Promise<string | null> {
  const key = `${connection.baseUrl}|${id}`
  const hit = cache.get(key)

  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)

    return hit
  }

  const loading = fetchImageBlob(connection, id).then(blob => (blob === null ? null : URL.createObjectURL(blob)))

  cache.set(key, loading)
  // A failure is not kept, so the next look tries again.
  void loading.then(url => {
    if (url === null) cache.delete(key)
  })

  for (const [oldest, dropped] of cache) {
    if (cache.size <= CACHE_LIMIT) break
    cache.delete(oldest)
    void dropped.then(url => {
      if (url !== null) URL.revokeObjectURL(url)
    })
  }

  return loading
}

type RemoteImageProps = {
  connection: Connection | null
  id: string
  alt: string
  // Starts loading only near the screen (long grids).
  lazy?: boolean
  // Offers a retry button after a failure (never inside another button).
  retry?: boolean
  className?: string
}

// A picture from a PC's bridge: a spinner while it comes, a plain note when
// it cannot (never the browser's broken-image box).
export function RemoteImage({ connection, id, alt, lazy = false, retry = false, className = '' }: RemoteImageProps) {
  const { t } = useI18n()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [near, setNear] = useState(!lazy)
  const [attempt, setAttempt] = useState(0)
  const holder = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const element = holder.current

    if (near || element === null) return

    const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { rootMargin: '400px' })

    observer.observe(element)

    return () => observer.disconnect()
  }, [near])

  useEffect(() => {
    if (!near || connection === null) return

    let cancelled = false

    setUrl(null)
    setFailed(false)
    void imageObjectUrl(connection, id).then(next => {
      if (cancelled) return
      setUrl(next)
      setFailed(next === null)
    })

    return () => {
      cancelled = true
    }
  }, [near, connection?.baseUrl, connection?.token, id, attempt])

  if (url !== null) return <img className={className} src={url} alt={alt} draggable={false} />

  return (
    <span className={`image-holder ${className}`} ref={holder}>
      {failed ? (
        <>
          <ImageIcon size={22} className="dim" />
          <span className="image-holder-text">{t('gallery.loadFailed')}</span>
          {retry && (
            <button type="button" className="btn small" onClick={() => setAttempt(value => value + 1)}>
              {t('gallery.retry')}
            </button>
          )}
        </>
      ) : (
        <SpinnerIcon size={18} className="dim" />
      )}
    </span>
  )
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

// Saves a picture where this device keeps them: the phone's Photos (the app
// shows its own toast), or the downloads folder on a PC. False when it failed.
export async function saveImage(connection: Connection, id: string, name: string): Promise<boolean> {
  const blob = await fetchImageBlob(connection, id)

  if (blob === null) return false

  const native = window.ChoiBuddyNative

  if (platform === 'android' && native?.saveImage !== undefined) return native.saveImage(await base64Of(blob), name, blob.type)

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)

  return true
}

// The phone's clipboard picture as a file for the composer, or null.
export function clipboardImageFile(): File | null {
  const native = window.ChoiBuddyNative

  if (native?.clipboardImage === undefined) return null

  try {
    const parsed: { name?: string; mime?: string; data?: string } | null = JSON.parse(native.clipboardImage())

    if (parsed === null || typeof parsed.data !== 'string' || typeof parsed.mime !== 'string') return null

    const bytes = Uint8Array.from(atob(parsed.data), char => char.charCodeAt(0))

    return new File([bytes], parsed.name ?? 'clipboard.png', { type: parsed.mime })
  } catch {
    return null
  }
}
