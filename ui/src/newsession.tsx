import { useEffect, useState } from 'react'
import type { Project } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { showToast } from './confirm.tsx'
import type { Feed } from './feeds.ts'
import { useI18n } from './i18n.ts'
import { fetchProjects, openNewSession } from './live.ts'
import { Picker } from './picker.tsx'

type Props = {
  feeds: Feed[]
  // The PC to suggest first: the one the person is looking at.
  preferredKey: string | null
  onClose: () => void
}

const CUSTOM = ''

// Opens Claude Code in a new terminal window on one of the PCs: pick the PC,
// a folder Claude ran in before (or type a path), and optionally the first
// prompt, which is handed to the session once it starts.
export function NewSessionSheet({ feeds, preferredKey, onClose }: Props) {
  const { t } = useI18n()
  const reachable = feeds.filter(feed => feed.snapshot !== null)
  const [pcKey, setPcKey] = useState(preferredKey !== null && reachable.some(feed => feed.key === preferredKey) ? preferredKey : (reachable[0]?.key ?? ''))
  const [projects, setProjects] = useState<Project[]>([])
  const [folder, setFolder] = useState(CUSTOM)
  const [custom, setCustom] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const feed = reachable.find(item => item.key === pcKey) ?? null

  useBackLayer(true, onClose)

  useEffect(() => {
    if (feed === null) return

    let cancelled = false

    void fetchProjects(feed.connection).then(list => {
      if (cancelled) return
      setProjects(list)
      setFolder(list[0]?.cwd ?? CUSTOM)
    })

    return () => {
      cancelled = true
    }
  }, [feed?.key, feed?.connection.token])

  const cwd = folder === CUSTOM ? custom.trim() : folder

  const open = async (): Promise<void> => {
    if (feed === null || cwd === '') return

    setBusy(true)

    const result = await openNewSession(feed.connection, cwd, prompt.trim())

    setBusy(false)
    showToast(result.ok ? t('newSession.opened', { terminal: result.terminal }) : `${t('newSession.failed')}: ${result.error}`)
    if (result.ok) onClose()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet new-session" role="dialog" aria-modal="true" aria-label={t('newSession.title')} onClick={event => event.stopPropagation()}>
        <div className="confirm-body">
          <div className="sheet-title">{t('newSession.title')}</div>
          <div className="confirm-hint">{t('newSession.hint')}</div>

          {reachable.length > 1 && (
            <div className="form-row">
              <span className="form-label">{t('newSession.pc')}</span>
              <Picker
                className="select"
                value={pcKey}
                title={t('newSession.pc')}
                options={reachable.map(item => ({ value: item.key, label: item.snapshot?.server.hostName ?? item.connection.baseUrl }))}
                onChange={setPcKey}
              />
            </div>
          )}

          <div className="form-row form-row--column">
            <span className="form-label">{t('newSession.folder')}</span>
            {projects.length === 0 && <span className="row-hint">{t('newSession.noFolders')}</span>}
            <div className="folder-list">
              {projects.map(project => (
                <label key={project.cwd} className={`folder ${folder === project.cwd ? 'on' : ''}`}>
                  <input type="radio" name="folder" checked={folder === project.cwd} onChange={() => setFolder(project.cwd)} />
                  <span className="folder-text">
                    <span className="folder-name">{project.name}</span>
                    <span className="folder-path">{project.cwd}</span>
                  </span>
                </label>
              ))}
              <label className={`folder ${folder === CUSTOM ? 'on' : ''}`}>
                <input type="radio" name="folder" checked={folder === CUSTOM} onChange={() => setFolder(CUSTOM)} />
                <span className="folder-text">
                  <span className="folder-name">{t('newSession.custom')}</span>
                  {folder === CUSTOM && (
                    <input className="field mono" value={custom} placeholder={'C:\\work\\project'} onChange={event => setCustom(event.target.value)} autoFocus />
                  )}
                </span>
              </label>
            </div>
          </div>

          <label className="form-row form-row--column">
            <span className="form-label">{t('newSession.prompt')}</span>
            <textarea className="field" rows={3} value={prompt} placeholder={t('newSession.promptPlaceholder')} onChange={event => setPrompt(event.target.value)} />
          </label>
        </div>
        <footer className="sheet-actions">
          <button type="button" className="btn btn--deny" onClick={onClose}>
            {t('action.cancel')}
          </button>
          <button type="button" className="btn btn--allow" disabled={busy || feed === null || cwd === ''} onClick={() => void open()}>
            {t('newSession.open')}
          </button>
        </footer>
      </div>
    </div>
  )
}
