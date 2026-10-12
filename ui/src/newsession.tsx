import { useEffect, useState } from 'react'
import type { Project } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { showToast } from './confirm.tsx'
import type { Feed } from './feeds.ts'
import { useI18n } from './i18n.ts'
import { type CodexState, fetchCodex, fetchProjects, fetchTerms, openNewSession, type SessionAgent, type TermState } from './live.ts'
import { Picker } from './picker.tsx'
import { isMac } from './platform.ts'
import { openTerminalTab } from './terminal.tsx'

type Props = {
  feeds: Feed[]
  // The PC to suggest first: the one the person is looking at.
  preferredKey: string | null
  onClose: () => void
}

const CUSTOM = ''

// Starts Claude Code or Codex on one of the PCs: pick the PC, the agent, a
// folder a session ran in before (or type a path), and optionally the first
// prompt. It opens in the app's own terminal, so it can be typed into right
// here; a window on the PC instead when asked, or when this device may not
// use the PC's terminals.
export function NewSessionSheet({ feeds, preferredKey, onClose }: Props) {
  const { t } = useI18n()
  const reachable = feeds.filter(feed => feed.snapshot !== null)
  const [pcKey, setPcKey] = useState(preferredKey !== null && reachable.some(feed => feed.key === preferredKey) ? preferredKey : (reachable[0]?.key ?? ''))
  const [projects, setProjects] = useState<Project[]>([])
  const [codex, setCodex] = useState<CodexState | null>(null)
  const [terms, setTerms] = useState<TermState | null>(null)
  const [agent, setAgent] = useState<SessionAgent>('claude')
  const [folder, setFolder] = useState(CUSTOM)
  const [custom, setCustom] = useState('')
  const [prompt, setPrompt] = useState('')
  const [pcWindow, setPcWindow] = useState(false)
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
    void fetchCodex(feed.connection).then(state => {
      if (!cancelled) setCodex(state)
    })
    void fetchTerms(feed.connection).then(state => {
      if (!cancelled) setTerms(state)
    })

    return () => {
      cancelled = true
    }
  }, [feed?.key, feed?.connection.token])

  const hasCodex = codex !== null && (codex.installed || codex.cli)
  const chosen: SessionAgent = hasCodex ? agent : 'claude'
  const canApp = terms !== null && terms.available && terms.allowed
  const inApp = canApp && !pcWindow
  // A window on the PC cannot hand Codex its first prompt.
  const promptOff = chosen === 'codex' && !inApp
  const cwd = folder === CUSTOM ? custom.trim() : folder
  // A Mac's folders start with /, a Windows PC's with a drive.
  const posixPaths = projects[0] === undefined ? isMac : projects[0].cwd.startsWith('/')

  const open = async (): Promise<void> => {
    if (feed === null || cwd === '') return

    if (inApp) {
      openTerminalTab({ pcKey: feed.key, cwd, run: chosen, prompt: prompt.trim(), title: '' })
      onClose()

      return
    }

    setBusy(true)

    const result = await openNewSession(feed.connection, cwd, promptOff ? '' : prompt.trim(), chosen)

    setBusy(false)
    showToast(result.ok ? t('newSession.opened', { terminal: result.terminal }) : `${t('newSession.failed')}: ${result.error}`)
    if (result.ok) onClose()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet new-session" role="dialog" aria-modal="true" aria-label={t('newSession.title')} onClick={event => event.stopPropagation()}>
        <div className="confirm-body">
          <div className="sheet-title">{t('newSession.title')}</div>
          <div className="confirm-hint">{inApp ? t('newSession.hintApp') : t('newSession.hint')}</div>

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

          {hasCodex && (
            <div className="form-row">
              <span className="form-label">{t('newSession.agent')}</span>
              <span className="seg">
                <button type="button" className={chosen === 'claude' ? 'on' : ''} onClick={() => setAgent('claude')}>
                  Claude Code
                </button>
                <button type="button" className={chosen === 'codex' ? 'on' : ''} onClick={() => setAgent('codex')}>
                  Codex
                </button>
              </span>
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
                    <input className="field mono" value={custom} placeholder={posixPaths ? '/Users/me/work/project' : 'C:\\work\\project'} onChange={event => setCustom(event.target.value)} autoFocus />
                  )}
                </span>
              </label>
            </div>
          </div>

          <label className="form-row form-row--column">
            <span className="form-label">{t('newSession.prompt')}</span>
            <textarea
              className="field"
              rows={3}
              value={promptOff ? '' : prompt}
              disabled={promptOff}
              placeholder={promptOff ? t('newSession.codexWindowPrompt') : t('newSession.promptPlaceholder')}
              onChange={event => setPrompt(event.target.value)}
            />
          </label>

          <label className="row">
            <span className="row-text">
              <span>{t('newSession.window')}</span>
              {!canApp && terms !== null && <span className="row-hint">{t('newSession.windowOnly')}</span>}
            </span>
            <input type="checkbox" className="switch" checked={!inApp} disabled={!canApp} onChange={event => setPcWindow(event.target.checked)} />
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
