import { useEffect, useState } from 'react'
import type { Decision, DecisionBehavior, Pending, Question } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { Buddy, type Tone } from './buddy.tsx'
import { type MessageKey, type Translate, useI18n } from './i18n.ts'
import { CheckIcon, ShieldIcon, XIcon } from './icons.tsx'
import { Markdown } from './markdown.tsx'
import { PreviewView } from './preview.tsx'

type SendResult = 'ok' | 'gone' | 'failed'

type SheetProps = {
  pending: Pending
  count: number
  cwd: string
  tone: Tone
  onDecide: (decision: Decision) => Promise<SendResult>
  onLater: () => void
}

export const KIND_LABEL: Record<Pending['kind'], MessageKey> = {
  permission: 'pending.permission',
  question: 'pending.question',
  plan: 'pending.plan',
}

function actionKey(tool: string): MessageKey | null {
  if (tool.startsWith('mcp__')) return 'pending.mcp'

  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return 'pending.bash'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'pending.edit'
    case 'Read':
      return 'pending.read'
    case 'WebFetch':
    case 'WebSearch':
      return 'pending.web'
    default:
      return null
  }
}

// What the request is, in the viewer's language: the action ("Run command")
// and what it acts on ("npm test"), kept apart so the detail can be set in code type.
export function pendingParts(t: Translate, pending: Pending): { action: string; detail: string } {
  if (pending.kind === 'question') return { action: pending.detail === '' ? t('pending.pickAnswer') : pending.detail, detail: '' }
  if (pending.kind === 'plan') return { action: t('pending.approvePlan'), detail: '' }

  const key = actionKey(pending.tool)

  return { action: key === null ? t('pending.tool', { tool: pending.tool }) : t(key), detail: pending.detail }
}

export function PendingHeadline({ pending }: { pending: Pending }) {
  const { t } = useI18n()
  const { action, detail } = pendingParts(t, pending)

  return (
    <>
      {action}
      {detail !== '' && (
        <>
          {' · '}
          <span className="fb-detail">{detail}</span>
        </>
      )}
    </>
  )
}

function QuestionBlock({ question, value, onChange }: { question: Question; value: string[]; onChange: (next: string[]) => void }) {
  const { t } = useI18n()
  const [custom, setCustom] = useState('')
  const toggle = (label: string): void => {
    setCustom('')
    if (!question.multiSelect) onChange([label])
    else onChange(value.includes(label) ? value.filter(item => item !== label) : [...value, label])
  }

  return (
    <div className="question">
      {question.header !== '' && <span className="pill">{question.header}</span>}
      <div className="question-text">{question.question}</div>
      <div className="options">
        {question.options.map(option => (
          <button type="button" key={option.label} className={`option ${value.includes(option.label) ? 'chosen' : ''}`} onClick={() => toggle(option.label)}>
            <span className="option-label">{option.label}</span>
            {option.description !== '' && <span className="option-desc">{option.description}</span>}
          </button>
        ))}
      </div>
      <input
        className="field"
        placeholder={t('pending.custom')}
        value={custom}
        onChange={event => {
          setCustom(event.target.value)
          onChange(event.target.value.trim() === '' ? [] : [event.target.value.trim()])
        }}
      />
    </div>
  )
}

export function PendingSheet({ pending, count, cwd, tone, onDecide, onLater }: SheetProps) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [feedback, setFeedback] = useState('')

  // Back puts the request aside, like ×; the badge brings it back.
  useBackLayer(true, onLater)

  useEffect(() => {
    setBusy(false)
    setNote(null)
    setAnswers({})
    setFeedback('')
  }, [pending.id])

  const send = async (behavior: DecisionBehavior): Promise<void> => {
    const answerMap: Record<string, string> = {}

    for (const question of pending.questions) {
      const chosen = answers[question.question] ?? []

      if (chosen.length > 0) answerMap[question.question] = chosen.join(', ')
    }

    setBusy(true)
    setNote(null)

    const result = await onDecide({
      id: pending.id,
      behavior,
      message: behavior === 'deny' && feedback.trim() !== '' ? feedback.trim() : null,
      answers: pending.kind === 'question' ? answerMap : null,
    })

    setBusy(false)
    if (result === 'failed') setNote(t('pending.failed'))
    if (result === 'gone') setNote(t('pending.gone'))
  }

  const allAnswered = pending.questions.every(question => (answers[question.question] ?? []).length > 0)

  return (
    <div className="sheet-backdrop">
      <div className={`sheet sheet--${pending.kind}`} role="dialog" aria-modal="true" aria-label={t(KIND_LABEL[pending.kind])}>
        <header className="sheet-head">
          <Buddy pose={pending.kind === 'question' ? 'question' : pending.kind === 'plan' ? 'plan' : 'warning'} mood="alert" tone={tone} />
          <div className="sheet-heading">
            <div className="sheet-kicker">
              <ShieldIcon size={13} />
              {t(KIND_LABEL[pending.kind])} · {pending.sessionName}
              {count > 1 && <span className="pill">+{count - 1}</span>}
            </div>
            <div className="sheet-title">{pending.kind === 'question' ? t('pending.pickAnswer') : <PendingHeadline pending={pending} />}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onLater} title={t('pending.later')}>
            <XIcon size={16} />
          </button>
        </header>

        <div className="sheet-body">
          {pending.kind === 'permission' && pending.preview !== null && <PreviewView preview={pending.preview} cwd={cwd} running={false} compact />}
          {pending.kind === 'question' &&
            pending.questions.map(question => (
              <QuestionBlock
                key={`${pending.id}-${question.question}`}
                question={question}
                value={answers[question.question] ?? []}
                onChange={next => setAnswers(current => ({ ...current, [question.question]: next }))}
              />
            ))}
          {pending.kind === 'plan' && (
            <>
              <div className="plan prose">
                <Markdown text={pending.plan ?? ''} />
              </div>
              <textarea className="field" rows={2} placeholder={t('pending.feedback')} value={feedback} onChange={event => setFeedback(event.target.value)} />
            </>
          )}
        </div>

        {note !== null && <div className="sheet-note">{note}</div>}

        <footer className="sheet-actions">
          {pending.kind === 'permission' && (
            <>
              <button type="button" className="btn btn--deny" disabled={busy} onClick={() => void send('deny')}>
                <XIcon size={16} /> {t('action.deny')}
              </button>
              {pending.canAlwaysAllow && (
                <button type="button" className="btn" disabled={busy} onClick={() => void send('always')}>
                  {t('action.always')}
                </button>
              )}
              <button type="button" className="btn btn--allow" disabled={busy} onClick={() => void send('allow')}>
                <CheckIcon size={16} /> {t('action.allow')}
              </button>
            </>
          )}
          {pending.kind === 'question' && (
            <>
              <button type="button" className="btn btn--deny" disabled={busy} onClick={() => void send('deny')}>
                {t('action.skip')}
              </button>
              <button type="button" className="btn btn--allow" disabled={busy || !allAnswered} onClick={() => void send('allow')}>
                <CheckIcon size={16} /> {t('action.answer')}
              </button>
            </>
          )}
          {pending.kind === 'plan' && (
            <>
              <button type="button" className="btn btn--deny" disabled={busy} onClick={() => void send('deny')}>
                {t('action.revise')}
              </button>
              <button type="button" className="btn btn--allow" disabled={busy} onClick={() => void send('allow')}>
                <CheckIcon size={16} /> {t('action.approve')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
