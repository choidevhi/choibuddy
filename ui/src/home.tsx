import { type RefObject, useEffect, useRef, useState } from 'react'
import type { Limits, LiveStream, Session, Step } from '../../shared/protocol.ts'
import { AgentLane } from './agents.tsx'
import { useBackLayer } from './back.ts'
import { Buddy, type Look, type Tone } from './buddy.tsx'
import { type CommandsFn, Composer, type UploadFn } from './chat.tsx'
import { ago, duration, useI18n } from './i18n.ts'
import { BanIcon, CheckCircleIcon, KindIcon, PlusIcon, SpinnerIcon, XCircleIcon } from './icons.tsx'
import { ModelControl, modelLabel } from './model.tsx'
import { LiveCodeView, LiveReplyView, MessageView, PreviewView } from './preview.tsx'
import { UsageStrip } from './usage.tsx'

const ROW_PX = 32

// How many step rows fit in the side column right now.
function useRowCapacity(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [capacity, setCapacity] = useState(4)

  useEffect(() => {
    const element = ref.current

    if (element === null) return

    const observer = new ResizeObserver(() => setCapacity(Math.max(1, Math.floor((element.clientHeight + 2) / ROW_PX))))

    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return [ref, capacity]
}

function toolLabel(step: Step): string {
  return step.tool.startsWith('mcp__') ? 'MCP' : step.tool
}

function StepIcon({ step }: { step: Step }) {
  switch (step.status) {
    case 'running':
      return <SpinnerIcon size={16} />
    case 'failed':
      return <XCircleIcon size={16} className="bad" />
    case 'denied':
      return <BanIcon size={16} />
    case 'done':
      return <KindIcon kind={step.kind} size={16} />
  }
}

function StepRow({ step, selected, onSelect }: { step: Step; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`step step--${step.status} ${selected ? 'selected' : ''}`} onClick={onSelect} title={step.title}>
      <StepIcon step={step} />
      <span className="step-tool">{toolLabel(step)}</span>
      <span className="step-title">{step.title}</span>
    </button>
  )
}

// A stream older than this belongs to a call that has finished.
const LIVE_MS = 15_000

type HomeProps = {
  session: Session | null
  stream: LiveStream | null
  sessions: Session[]
  limits: Limits | null
  look: Look
  tone: Tone
  now: number
  compact: boolean
  // Little height to spare (the phone keyboard is up): a smaller buddy and no
  // tool list, so the prompt box, the agents and the usage stay in view.
  short: boolean
  onPick: (sessionId: string) => void
  onSend: (sessionId: string, text: string) => Promise<boolean>
  onUpload: UploadFn
  loadCommands: CommandsFn
  onNewSession: () => void
}

type PickerProps = {
  session: Session | null
  sessions: Session[]
  onPick: (sessionId: string) => void
  onNewSession: () => void
}

function SessionPicker({ session, sessions, onPick, onNewSession }: PickerProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  useBackLayer(open, () => setOpen(false))

  return (
    <div className="picker">
      <button type="button" className="who-name picker-button" onClick={() => setOpen(!open)} title={t('home.pickSession')}>
        {session?.name ?? 'ChoiBuddy'}
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="picker-menu" role="menu">
          {sessions.map(item => (
            <button
              type="button"
              key={item.id}
              role="menuitem"
              className={`picker-item ${item.id === session?.id ? 'on' : ''}`}
              onClick={() => {
                onPick(item.id)
                setOpen(false)
              }}
            >
              <span className={`status-dot dot--${item.status}`} />
              <span className="picker-name">{item.name}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="picker-item picker-new"
            onClick={() => {
              setOpen(false)
              onNewSession()
            }}
          >
            <PlusIcon size={13} />
            <span className="picker-name">{t('chat.newSession')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

export function Home({ session, stream, sessions, limits, look, tone, now, compact, short, onPick, onSend, onUpload, loadCommands, onNewSession }: HomeProps) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [stepsRef, capacity] = useRowCapacity()
  const agent = session?.agents.find(item => item.id === agentId) ?? null
  const agentStep = agent?.steps.findLast(step => step.preview !== null) ?? null
  const turnSteps = session === null ? [] : session.steps.filter(step => step.startedAt >= session.turnStartedAt)
  const finished = session?.status === 'done'
  const thinkingRow = session?.status === 'thinking' && turnSteps.every(step => step.status !== 'running')
  // The closing row (Done / Thinking) shares the space with the step rows.
  const rows = turnSteps.slice(-Math.max(1, capacity - (finished || thinkingRow ? 1 : 0)))
  const latestId = session?.steps.at(-1)?.id ?? null

  // A picked step or agent is a look back; back returns to the live view.
  useBackLayer(selectedId !== null || agentId !== null, () => {
    setSelectedId(null)
    setAgentId(null)
  })

  // A new step takes the stage again, even after the person picked an older one.
  useEffect(() => setSelectedId(null), [latestId, session?.id])
  useEffect(() => setAgentId(null), [session?.id])

  const selected = session?.steps.find(step => step.id === selectedId) ?? session?.steps.findLast(step => step.preview !== null) ?? null
  const showMessage = session !== null && selectedId === null && (session.status === 'done' || session.status === 'idle') && session.message !== null
  const busy = session !== null && (session.status === 'working' || session.status === 'thinking' || session.status === 'waiting')
  // Code still being typed: the tool call has not reached the hooks yet.
  const writing =
    stream !== null &&
    stream.toolUseId !== null &&
    busy &&
    now - stream.at < LIVE_MS &&
    session !== null &&
    !session.steps.some(step => step.id === stream.toolUseId)
      ? stream
      : null
  // Claude writing its answer (no tool yet): shown as it comes, word by word.
  const replying =
    writing === null && stream !== null && stream.toolUseId === null && busy && now - stream.at < LIVE_MS && stream.text.trim() !== '' ? stream : null

  return (
    <div className={`home ${compact ? 'home--compact' : ''} ${short ? 'home--short' : ''}`}>
      <aside className="side">
        <div className="buddy-wrap">
          <Buddy pose={look.pose} mood={look.mood} tone={tone} size={short ? 52 : compact ? 76 : 92} />
        </div>
        <div className="who">
          <SessionPicker session={session} sessions={sessions} onPick={onPick} onNewSession={onNewSession} />
          <div className="who-sub">
            {modelLabel(session?.usage?.model ?? null) ?? 'Claude Code'}
            {session !== null && session.subagents > 0 && <span className="pill">{t('home.agents', { n: session.subagents })}</span>}
          </div>
        </div>
        <div className={`status status--${session?.status ?? 'none'}`}>
          <span className="status-dot" />
          <span>{t(look.label)}</span>
          {busy && session !== null && <span className="status-time">{duration(t, now - session.turnStartedAt)}</span>}
        </div>
        <div className="steps" ref={stepsRef}>
          {rows.map(step => (
            <StepRow
              key={step.id}
              step={step}
              selected={agent === null && selected?.id === step.id && !showMessage}
              onSelect={() => {
                setAgentId(null)
                setSelectedId(step.id)
              }}
            />
          ))}
          {session !== null && finished && (
            <div className="step step--finish">
              <CheckCircleIcon size={16} />
              <span className="step-tool">Done</span>
              <span className="step-title">{ago(t, now - session.updatedAt)}</span>
            </div>
          )}
          {thinkingRow && (
            <div className="step step--running">
              <SpinnerIcon size={16} />
              <span className="step-tool">Thinking</span>
            </div>
          )}
        </div>
      </aside>
      <section className="stage">
        {writing !== null && agent === null && selectedId === null ? (
          <LiveCodeView stream={writing} />
        ) : replying !== null && agent === null && selectedId === null ? (
          <LiveReplyView stream={replying} />
        ) : agent !== null && session !== null ? (
          agentStep !== null && agentStep.preview !== null && (agent.status === 'running' || agent.message === null) ? (
            <PreviewView preview={agentStep.preview} cwd={session.cwd} running={agentStep.status === 'running'} />
          ) : (
            <MessageView title={agent.type} text={agent.message ?? agent.description} />
          )
        ) : session === null ? (
          <div className="empty">
            <div className="empty-title">{t('home.waitingTitle')}</div>
            <div className="empty-sub">{t('home.waitingSub')}</div>
            <button type="button" className="btn btn--allow" onClick={onNewSession}>
              <PlusIcon size={15} /> {t('newSession.title')}
            </button>
          </div>
        ) : showMessage && session.message !== null ? (
          <MessageView title={t('home.reply')} text={session.message} />
        ) : selected !== null && selected.preview !== null ? (
          <PreviewView preview={selected.preview} cwd={session.cwd} running={selected.status === 'running'} />
        ) : session.prompt !== null ? (
          <MessageView title={t('home.request')} text={session.prompt} />
        ) : (
          <div className="empty">
            <div className="empty-title">{t(look.label)}</div>
            <div className="empty-sub">{session.cwd}</div>
          </div>
        )}
        {session !== null && <AgentLane agents={session.agents} selectedId={agentId} tone={tone} now={now} onSelect={setAgentId} />}
        {session !== null && <Composer session={session} onSend={onSend} onUpload={onUpload} loadCommands={loadCommands} compact />}
      </section>
      <UsageStrip usage={session?.usage ?? null} limits={limits} now={now} lead={session === null ? null : <ModelControl session={session} onSend={onSend} />} />
    </div>
  )
}
