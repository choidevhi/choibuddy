import { useContext, useEffect, useState } from 'react'
import type { Session } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { showToast } from './confirm.tsx'
import { type MessageKey, type Translate, useI18n } from './i18n.ts'
import { type CodexModelChoice, ConnectionContext, fetchCodexModels, setCodexSettings } from './live.ts'

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

type Effort = (typeof EFFORTS)[number]

const EFFORT_LABEL = {
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
} as const satisfies Record<Effort, MessageKey>

function isEffort(value: string): value is Effort {
  return EFFORTS.some(effort => effort === value)
}

// "claude-opus-5-5" → "Opus 5.5"; an id in another form is shown as it is.
export function modelLabel(id: string | null): string | null {
  if (id === null) return null

  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\D|$)/.exec(id)
  const family = match?.[1]
  const major = match?.[2]

  if (family === undefined || major === undefined) return id

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${match?.[3] === undefined ? '' : `.${match[3]}`}`
}

export function effortLabel(t: Translate, effort: string): string {
  return isEffort(effort) ? t(EFFORT_LABEL[effort]) : effort
}

type Props = {
  session: Session
  onSend: (sessionId: string, text: string) => Promise<boolean>
}

// A Codex session's model and effort, as its record says.
export function CodexModel({ session }: { session: Session }) {
  const { t } = useI18n()
  const model = session.usage?.model ?? null
  const effort = session.usage?.effort ?? null

  return (
    <div className="model-control">
      <span className="model-chip model-chip--still">
        <span className="model-chip-name">{model ?? 'Codex'}</span>
        {effort !== null && <span className="model-chip-effort">{effortLabel(t, effort)}</span>}
      </span>
    </div>
  )
}

// A Codex session ChoiBuddy runs: its model and effort from Codex's own
// list; the next turn runs with them.
export function CodexModelControl({ session }: { session: Session }) {
  const { t } = useI18n()
  const connection = useContext(ConnectionContext)
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<CodexModelChoice[]>([])
  const model = session.usage?.model ?? null
  const effort = session.usage?.effort ?? null
  const current = models.find(item => item.id === model) ?? null

  useBackLayer(open, () => setOpen(false))

  useEffect(() => {
    if (open && connection !== null && models.length === 0) void fetchCodexModels(connection).then(setModels)
  }, [open, connection?.baseUrl])

  const pick = (nextModel: string, nextEffort: string): void => {
    setOpen(false)
    if (connection !== null) void setCodexSettings(connection, session.id, nextModel, nextEffort).then(ok => (ok ? undefined : showToast(t('chat.actionFailed'))))
  }

  return (
    <div className="model-control">
      <button type="button" className="model-chip" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="model-chip-name">{model ?? 'Codex'}</span>
        {effort !== null && <span className="model-chip-effort">{effortLabel(t, effort)}</span>}
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="model-menu" role="menu">
          <div className="model-menu-label">{t('model.title')}</div>
          <div className="model-menu-row">
            {models.length === 0 && <span className="model-menu-note">{t('chat.loading')}</span>}
            {models.map(item => (
              <button type="button" role="menuitem" key={item.id} className={`model-option ${model === item.id ? 'on' : ''}`} onClick={() => pick(item.id, '')}>
                {item.name}
              </button>
            ))}
          </div>
          {current !== null && current.efforts.length > 0 && (
            <>
              <div className="model-menu-label">{t('model.effort')}</div>
              <div className="model-menu-row">
                {current.efforts.map(level => (
                  <button type="button" role="menuitem" key={level} className={`model-option ${effort === level ? 'on' : ''}`} onClick={() => pick('', level)}>
                    {effortLabel(t, level)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// The session's model and effort, and a menu to change either. Changes go
// to Claude Code as /model and /effort, the same as typing them.
export function ModelControl({ session, onSend }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const model = session.usage?.model ?? null
  const effort = session.usage?.effort ?? null
  const can = session.canCommand

  useBackLayer(open, () => setOpen(false))

  const run = (text: string): void => {
    setOpen(false)
    void onSend(session.id, text)
  }

  return (
    <div className="model-control">
      <button type="button" className="model-chip" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="model-chip-name">{modelLabel(model) ?? t('model.pending')}</span>
        {effort !== null && <span className="model-chip-effort">{effortLabel(t, effort)}</span>}
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="model-menu" role="menu">
          {!can && <div className="model-menu-note">{t('model.needsMod')}</div>}
          <div className="model-menu-label">{t('model.title')}</div>
          <div className="model-menu-row">
            {MODELS.map(id => (
              <button type="button" role="menuitem" key={id} disabled={!can} className={`model-option ${model === id ? 'on' : ''}`} onClick={() => run(`/model ${id}`)}>
                {modelLabel(id)}
              </button>
            ))}
          </div>
          <div className="model-menu-label">{t('model.effort')}</div>
          <div className="model-menu-row">
            {EFFORTS.map(level => (
              <button type="button" role="menuitem" key={level} disabled={!can} className={`model-option ${effort === level ? 'on' : ''}`} onClick={() => run(`/effort ${level}`)}>
                {t(EFFORT_LABEL[level])}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
