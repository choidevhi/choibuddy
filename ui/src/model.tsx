import { useContext, useEffect, useState } from 'react'
import type { Session } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from './icons.tsx'
import { showToast } from './confirm.tsx'
import { type MessageKey, type Translate, useI18n } from './i18n.ts'
import { type CodexModelChoice, ConnectionContext, fetchCodexModels, setCodexSettings } from './live.ts'

// In the order the sheet lists them, the most capable everyday one first.
const MODELS = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const

const MODEL_NOTE = {
  'claude-opus-5-5': 'model.note.opus',
  'claude-fable-5-1': 'model.note.fable',
  'claude-sonnet-5-5': 'model.note.sonnet',
  'claude-haiku-5-5': 'model.note.haiku',
} as const satisfies Record<(typeof MODELS)[number], MessageKey>
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

type Effort = (typeof EFFORTS)[number]

const EFFORT_LABEL = {
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
} as const satisfies Record<Effort, MessageKey>

const EFFORT_NOTE = {
  low: 'effort.note.low',
  medium: 'effort.note.medium',
  high: 'effort.note.high',
  xhigh: 'effort.note.xhigh',
  max: 'effort.note.max',
} as const satisfies Record<Effort, MessageKey>

function effortNote(t: Translate, effort: string): string {
  return isEffort(effort) ? t(EFFORT_NOTE[effort]) : ''
}

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

// One choice in the sheet: a model or an effort level, with a short line
// on what it is for.
type Choice = { id: string; label: string; note: string }

type SheetProps = {
  models: Choice[]
  model: string | null
  efforts: Choice[]
  effort: string | null
  // Shown over the list when nothing can be changed yet.
  note: string | null
  loading: boolean
  onModel: (id: string) => void
  onEffort: (id: string) => void
  onClose: () => void
}

// The model and effort, picked in a sheet from the bottom (a card in the
// middle on a wide screen): the models with what each is for, then a row
// that opens the effort levels on a page of their own.
function ModelSheet({ models, model, efforts, effort, note, loading, onModel, onEffort, onClose }: SheetProps) {
  const { t } = useI18n()
  const [page, setPage] = useState<'models' | 'efforts'>('models')
  const currentEffort = efforts.find(item => item.id === effort) ?? null

  useBackLayer(true, () => (page === 'efforts' ? setPage('models') : onClose()))

  return (
    <div className="model-sheet-backdrop" onClick={onClose}>
      <div className="model-sheet" role="dialog" aria-modal="true" aria-label={t('model.title')} onClick={event => event.stopPropagation()}>
        <span className="model-sheet-grip" />
        <header className="model-sheet-head">
          {page === 'efforts' ? (
            <button type="button" className="icon-btn" onClick={() => setPage('models')} aria-label={t('action.back')} title={t('action.back')}>
              <ChevronLeftIcon size={20} />
            </button>
          ) : (
            <button type="button" className="icon-btn" onClick={onClose} aria-label={t('action.close')} title={t('action.close')}>
              <XIcon size={20} />
            </button>
          )}
          <span className="model-sheet-title">{t(page === 'efforts' ? 'model.effortTitle' : 'model.pick')}</span>
          <span className="model-sheet-side" />
        </header>
        {note !== null && <div className="model-sheet-note">{note}</div>}
        {page === 'models' ? (
          <>
            <div className="model-sheet-group">
              {loading && <div className="model-sheet-empty">{t('chat.loading')}</div>}
              {models.map(item => (
                <button type="button" key={item.id} className="model-sheet-row" disabled={note !== null} onClick={() => onModel(item.id)}>
                  <span className="model-sheet-text">
                    <span className="model-sheet-name">{item.label}</span>
                    {item.note !== '' && <span className="model-sheet-desc">{item.note}</span>}
                  </span>
                  {item.id === model && <CheckIcon size={20} className="model-sheet-check" />}
                </button>
              ))}
            </div>
            {efforts.length > 0 && (
              <div className="model-sheet-group">
                <button type="button" className="model-sheet-row" disabled={note !== null} onClick={() => setPage('efforts')}>
                  <span className="model-sheet-name">{t('model.effortTitle')}</span>
                  <span className="model-sheet-value">{currentEffort?.label ?? ''}</span>
                  <ChevronRightIcon size={18} className="model-sheet-more" />
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="model-sheet-group">
            {efforts.map(item => (
              <button type="button" key={item.id} className="model-sheet-row" disabled={note !== null} onClick={() => onEffort(item.id)}>
                <span className="model-sheet-text">
                  <span className="model-sheet-name">{item.label}</span>
                  {item.note !== '' && <span className="model-sheet-desc">{item.note}</span>}
                </span>
                {item.id === effort && <CheckIcon size={20} className="model-sheet-check" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// The chip in the prompt box: the model, the effort, and the sheet to change them.
function ModelChip({ name, effort, onOpen }: { name: string; effort: string | null; onOpen: () => void }) {
  return (
    <button type="button" className="model-chip" onClick={onOpen} aria-haspopup="dialog">
      <span className="model-chip-name">{name}</span>
      {effort !== null && <span className="model-chip-effort">{effort}</span>}
      <ChevronDownIcon size={13} className="picker-caret" />
    </button>
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

  useEffect(() => {
    if (open && connection !== null && models.length === 0) void fetchCodexModels(connection).then(setModels)
  }, [open, connection?.baseUrl])

  const pick = (nextModel: string, nextEffort: string): void => {
    setOpen(false)
    if (connection !== null) void setCodexSettings(connection, session.id, nextModel, nextEffort).then(ok => (ok ? undefined : showToast(t('chat.actionFailed'))))
  }

  return (
    <div className="model-control">
      <ModelChip name={model ?? 'Codex'} effort={effort === null ? null : effortLabel(t, effort)} onOpen={() => setOpen(true)} />
      {open && (
        <ModelSheet
          models={models.map(item => ({ id: item.id, label: item.name, note: '' }))}
          model={model}
          efforts={(current?.efforts ?? []).map(level => ({ id: level, label: effortLabel(t, level), note: effortNote(t, level) }))}
          effort={effort}
          note={null}
          loading={models.length === 0}
          onModel={id => pick(id, '')}
          onEffort={level => pick('', level)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

// The session's model and effort, and the sheet to change either. Changes go
// to Claude Code as /model and /effort, the same as typing them.
export function ModelControl({ session, onSend }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const model = session.usage?.model ?? null
  const effort = session.usage?.effort ?? null

  const run = (text: string): void => {
    setOpen(false)
    void onSend(session.id, text)
  }

  return (
    <div className="model-control">
      <ModelChip name={modelLabel(model) ?? t('model.pending')} effort={effort === null ? null : effortLabel(t, effort)} onOpen={() => setOpen(true)} />
      {open && (
        <ModelSheet
          models={MODELS.map(id => ({ id, label: modelLabel(id) ?? id, note: t(MODEL_NOTE[id]) }))}
          model={model}
          efforts={EFFORTS.map(level => ({ id: level, label: t(EFFORT_LABEL[level]), note: t(EFFORT_NOTE[level]) }))}
          effort={effort}
          note={session.canCommand ? null : t('model.needsMod')}
          loading={false}
          onModel={id => run(`/model ${id}`)}
          onEffort={level => run(`/effort ${level}`)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
