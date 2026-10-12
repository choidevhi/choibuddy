import { useEffect, useState } from 'react'
import type { GalleryImage } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { ConfirmSheet, showToast } from './confirm.tsx'
import { type Feed, feedFor } from './feeds.ts'
import { ago, useI18n } from './i18n.ts'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, ImageIcon, TrashIcon, XIcon } from './icons.tsx'
import { RemoteImage, saveImage } from './images.tsx'
import { clearGallery, deleteImage, fetchGallery, fetchHistory } from './live.ts'
import { platform } from './platform.ts'

type PcImage = GalleryImage & { pcKey: string }

const ALL = ''

// A project is a folder on one PC (the gallery keeps the folder's name).
function projectKey(image: PcImage): string {
  return `${image.pcKey}|${image.sessionName}`
}

type Project = { key: string; name: string; count: number }

type Group = { sessionId: string; pcKey: string; project: string; latestAt: number; images: PcImage[] }

// Projects, busiest-latest first, from images that are already newest first.
export function projectsOf(images: PcImage[]): Project[] {
  const byKey = new Map<string, Project>()

  for (const image of images) {
    const key = projectKey(image)
    const project = byKey.get(key)

    if (project === undefined) byKey.set(key, { key, name: image.sessionName, count: 1 })
    else project.count += 1
  }

  return [...byKey.values()]
}

// One group per session, in the order their newest picture came.
export function groupsOf(images: PcImage[]): Group[] {
  const bySession = new Map<string, Group>()

  for (const image of images) {
    const key = `${image.pcKey}|${image.sessionId}`
    const group = bySession.get(key)

    if (group === undefined) bySession.set(key, { sessionId: image.sessionId, pcKey: image.pcKey, project: image.sessionName, latestAt: image.at, images: [image] })
    else group.images.push(image)
  }

  return [...bySession.values()]
}

type Confirm = { kind: 'clear' } | { kind: 'image' } | { kind: 'session'; group: Group }

// Every picture Claude looked at, on every PC, newest first, by project and
// then by session; opens into a viewer that pages through the pictures shown
// (← → on a keyboard). Pictures can be saved to this device, taken off the
// list one by one or a session at a time, or the list emptied; files Claude
// read are never deleted from the PC.
export function Gallery({ feeds, latestAt, now }: { feeds: Feed[]; latestAt: number; now: number }) {
  const { t } = useI18n()
  const [images, setImages] = useState<PcImage[]>([])
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map())
  const [project, setProject] = useState(ALL)
  const [open, setOpen] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const feedIds = feeds.map(feed => `${feed.key}#${feed.connection.token}`).join('|')

  // Pictures from every PC, newest first.
  useEffect(() => {
    void Promise.all(feeds.map(feed => fetchGallery(feed.connection).then(list => list.map((image): PcImage => ({ ...image, pcKey: feed.key }))))).then(lists =>
      setImages(lists.flat().sort((a, b) => b.at - a.at)),
    )
    // feedIds stands for the feeds that matter here.
  }, [feedIds, latestAt, reload])

  // Session titles, to name the groups.
  useEffect(() => {
    void Promise.all(feeds.map(feed => fetchHistory(feed.connection))).then(lists => {
      const next = new Map<string, string>()

      for (const entry of lists.flat()) {
        if (entry.title !== '') next.set(entry.sessionId, entry.title)
      }

      setTitles(next)
    })
  }, [feedIds])

  const projects = projectsOf(images)
  const chosen = projects.some(item => item.key === project) ? project : ALL
  const groups = groupsOf(chosen === ALL ? images : images.filter(image => projectKey(image) === chosen))
  // The viewer pages through the pictures in the order they are drawn.
  const shownImages = groups.flatMap(group => group.images)
  const shown = open === null ? undefined : shownImages[open]
  // Where each group's pictures start in that order.
  const starts: number[] = []
  let offset = 0

  for (const group of groups) {
    starts.push(offset)
    offset += group.images.length
  }

  const connectionOf = (image: PcImage) => feedFor(feeds, image.pcKey)?.connection ?? null

  useBackLayer(open !== null, () => setOpen(null))

  useEffect(() => {
    if (open === null) return

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(null)
      if (event.key === 'ArrowLeft') setOpen(index => (index === null ? null : Math.max(0, index - 1)))
      if (event.key === 'ArrowRight') setOpen(index => (index === null ? null : Math.min(shownImages.length - 1, index + 1)))
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [open, shownImages.length])

  const save = async (image: PcImage): Promise<void> => {
    const connection = connectionOf(image)

    if (connection === null) return

    const ok = await saveImage(connection, image.id, image.name)

    // The phone shows its own toast once the picture is in Photos.
    if (platform !== 'android') showToast(ok ? t('gallery.saved') : t('gallery.saveFailed'))
  }

  const removeImages = async (list: PcImage[]): Promise<Set<string>> => {
    const removed = new Set<string>()

    for (const image of list) {
      const connection = connectionOf(image)

      if (connection !== null && (await deleteImage(connection, image.id))) removed.add(`${image.pcKey}|${image.id}`)
    }

    return removed
  }

  const remove = async (): Promise<void> => {
    if (confirm === null) return

    setBusy(true)

    if (confirm.kind === 'clear') {
      await Promise.all(feeds.map(feed => clearGallery(feed.connection)))
      setImages([])
      setOpen(null)
    } else {
      const target = confirm.kind === 'session' ? confirm.group.images : shown === undefined ? [] : [shown]
      const removed = await removeImages(target)

      setImages(list => list.filter(item => !removed.has(`${item.pcKey}|${item.id}`)))
      setOpen(index => (index === null || confirm.kind === 'session' || shownImages.length <= 1 ? null : Math.min(index, shownImages.length - 2)))
    }

    setBusy(false)
    setConfirm(null)
    setReload(value => value + 1)
  }

  const confirmText = (): { title: string; hint: string; label: string } => {
    if (confirm?.kind === 'clear') return { title: t('gallery.clearTitle'), hint: t('gallery.clearHint'), label: t('gallery.clear') }
    if (confirm?.kind === 'session') return { title: t('gallery.deleteSessionTitle', { n: confirm.group.images.length }), hint: t('gallery.deleteHint'), label: t('action.delete') }

    return { title: shown?.name ?? '', hint: t('gallery.deleteHint'), label: t('action.delete') }
  }

  return (
    <div className="gallery">
      {images.length === 0 ? (
        <div className="empty">
          <ImageIcon size={28} className="dim" />
          <div className="empty-title">{t('gallery.empty')}</div>
          <div className="empty-sub">{t('gallery.emptySub')}</div>
        </div>
      ) : (
        <>
          <div className="gallery-bar">
            <div className="gallery-projects" role="tablist">
              <button type="button" role="tab" aria-selected={chosen === ALL} className={`gallery-project ${chosen === ALL ? 'on' : ''}`} onClick={() => setProject(ALL)}>
                {t('gallery.all')} <span className="gallery-project-count">{images.length}</span>
              </button>
              {projects.map(item => (
                <button type="button" role="tab" aria-selected={chosen === item.key} key={item.key} className={`gallery-project ${chosen === item.key ? 'on' : ''}`} onClick={() => setProject(item.key)}>
                  {item.name} <span className="gallery-project-count">{item.count}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn small" onClick={() => setConfirm({ kind: 'clear' })}>
              <TrashIcon size={14} /> {t('gallery.clear')}
            </button>
          </div>

          {groups.map((group, groupIndex) => {
            const first = starts[groupIndex] ?? 0

            return (
              <section className="gallery-group" key={`${group.pcKey}|${group.sessionId}`}>
                <header className="gallery-group-head">
                  <span className="gallery-group-title">{titles.get(group.sessionId) ?? t('gallery.session', { id: group.sessionId.slice(0, 8) })}</span>
                  <span className="gallery-group-meta">
                    {chosen === ALL && `${group.project} · `}
                    {t('gallery.count', { n: group.images.length })} · {ago(t, now - group.latestAt)}
                  </span>
                  <button type="button" className="icon-btn" onClick={() => setConfirm({ kind: 'session', group })} title={t('gallery.deleteSession')} aria-label={t('gallery.deleteSession')}>
                    <TrashIcon size={14} />
                  </button>
                </header>
                <div className="gallery-grid">
                  {group.images.map((image, index) => (
                    <button type="button" key={`${image.pcKey}-${image.id}`} className="thumb" onClick={() => setOpen(first + index)} title={image.path ?? image.name}>
                      <RemoteImage connection={connectionOf(image)} id={image.id} alt={image.name} lazy />
                      <span className="thumb-caption">
                        <span className="thumb-name">{image.name}</span>
                        <span className="thumb-meta">
                          {image.tool} · {ago(t, now - image.at)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
        </>
      )}

      {shown !== undefined && open !== null && (
        <div className="viewer" role="dialog" aria-modal="true" aria-label={shown.name}>
          <div className="viewer-head">
            <span className="viewer-title">
              <span className="viewer-name">{shown.name}</span>
              <span className="viewer-meta">
                {shown.sessionName} · {titles.get(shown.sessionId) ?? shown.sessionId.slice(0, 8)} · {ago(t, now - shown.at)} · {open + 1}/{shownImages.length}
              </span>
            </span>
            <button type="button" className="icon-btn" onClick={() => void save(shown)} title={t('gallery.save')}>
              <DownloadIcon size={18} />
            </button>
            <button type="button" className="icon-btn" onClick={() => setConfirm({ kind: 'image' })} title={t('action.delete')}>
              <TrashIcon size={18} />
            </button>
            <button type="button" className="icon-btn" onClick={() => setOpen(null)} title={t('action.close')}>
              <XIcon size={18} />
            </button>
          </div>
          <div className="viewer-body">
            <RemoteImage key={`${shown.pcKey}-${shown.id}`} connection={connectionOf(shown)} id={shown.id} alt={shown.name} retry />
          </div>
          {open > 0 && (
            <button type="button" className="edge edge--left" onClick={() => setOpen(open - 1)}>
              <ChevronLeftIcon size={18} />
            </button>
          )}
          {open < shownImages.length - 1 && (
            <button type="button" className="edge edge--right" onClick={() => setOpen(open + 1)}>
              <ChevronRightIcon size={18} />
            </button>
          )}
        </div>
      )}

      {confirm !== null && (
        <ConfirmSheet
          title={confirmText().title}
          hint={confirmText().hint}
          confirmLabel={confirmText().label}
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
