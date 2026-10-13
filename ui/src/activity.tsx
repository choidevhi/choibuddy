import { useEffect, useState } from 'react'
import type { Limits, LiveStream, Session, Step } from '../../shared/protocol.ts'
import { AgentLane } from './agents.tsx'
import { useBackLayer } from './back.ts'
import { Buddy, lookFor, type Tone } from './buddy.tsx'
import { ago, duration, useI18n } from './i18n.ts'
import { BanIcon, CheckCircleIcon, ChevronDownIcon, KindIcon, SpinnerIcon, XCircleIcon } from './icons.tsx'
import type { LinkState } from './live.ts'
import { modelLabel } from './model.tsx'
import { LiveCodeView, MessageView, PreviewView } from './preview.tsx'
import { UsageStrip } from './usage.tsx'

// What a live session is doing, beside its conversation: the buddy and its
// status, this turn's tool steps, the code being written or the step picked,
// the agents, and the usage. On a wide pane a column on the right; on a
// narrow one a single line over the conversation that folds out.

// A stream older than this belongs to a call that has finished.
const LIVE_MS = 15_000
// The side column shows this many of the turn's latest steps.
const SIDE_STEPS = 8

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

type Props = {
  session: Session
  stream: LiveStream | undefined
  limits: Limits | null
  link: LinkState
  tone: Tone
  now: number
  side: boolean
}

export function Activity({ session, stream, limits, link, tone, now, side }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const look = lookFor(session, link, now)
  const busy = session.status === 'working' || session.status === 'thinking' || session.status === 'waiting'
  const turnSteps = session.steps.filter(step => step.startedAt >= session.turnStartedAt)
  const latestId = session.steps.at(-1)?.id ?? null
  const agent = session.agents.find(item => item.id === agentId) ?? null
  const agentStep = agent?.steps.findLast(step => step.preview !== null) ?? null
  const picked = session.steps.find(step => step.id === selectedId) ?? null
  const running = turnSteps.findLast(step => step.status === 'running') ?? null
  // Code still being typed: the tool call has not reached the hooks yet.
  const writing =
    stream !== undefined && stream.toolUseId !== null && busy && now - stream.at < LIVE_MS && !session.steps.some(step => step.id === stream.toolUseId) ? stream : null
  const model = session.usage?.model ?? null
  const agentLine = session.agent === 'codex' ? (model === null ? 'Codex' : `Codex · ${model}`) : (modelLabel(model) ?? 'Claude Code')
  // The line's one-glance summary: what runs now, else the last step.
  const headline = running ?? turnSteps.at(-1) ?? null

  useBackLayer(!side && open, () => setOpen(false), false)

  // A new step takes over again, even after an older one was picked.
  useEffect(() => setSelectedId(null), [latestId, session.id])
  useEffect(() => setAgentId(null), [session.id])

  const stage =
    writing !== null && agent === null && selectedId === null ? (
      <LiveCodeView stream={writing} />
    ) : agent !== null ? (
      agentStep !== null && agentStep.preview !== null && (agent.status === 'running' || agent.message === null) ? (
        <PreviewView preview={agentStep.preview} cwd={session.cwd} running={agentStep.status === 'running'} compact />
      ) : (
        <MessageView title={agent.type} text={agent.message ?? agent.description} />
      )
    ) : picked !== null && picked.preview !== null ? (
      <PreviewView preview={picked.preview} cwd={session.cwd} running={picked.status === 'running'} compact />
    ) : running !== null && running.preview !== null ? (
      <PreviewView preview={running.preview} cwd={session.cwd} running compact />
    ) : null

  const steps = (
    <div className="activity-steps">
      {turnSteps.slice(side ? -SIDE_STEPS : undefined).map(step => (
        <button
          type="button"
          key={step.id}
          className={`step step--${step.status} ${selectedId === step.id ? 'selected' : ''}`}
          onClick={() => {
            setAgentId(null)
            setSelectedId(selectedId === step.id ? null : step.id)
          }}
          title={step.title}
        >
          <StepIcon step={step} />
          <span className="step-tool">{toolLabel(step)}</span>
          <span className="step-title">{step.title}</span>
        </button>
      ))}
      {session.status === 'done' && (
        <div className="step step--finish">
          <CheckCircleIcon size={16} />
          <span className="step-tool">Done</span>
          <span className="step-title">{ago(t, now - session.updatedAt)}</span>
        </div>
      )}
      {session.status === 'thinking' && running === null && (
        <div className="step step--running">
          <SpinnerIcon size={16} />
          <span className="step-tool">Thinking</span>
        </div>
      )}
    </div>
  )

  const usage = (
    <UsageStrip
      usage={session.usage ?? null}
      limits={limits}
      now={now}
    />
  )

  const lane = <AgentLane agents={session.agents} selectedId={agentId} tone={tone} now={now} onSelect={setAgentId} />

  if (side) {
    return (
      <aside className="activity activity--side">
        <div className="activity-who">
          <Buddy pose={look.pose} mood={look.mood} tone={tone} size={56} />
          <div className="activity-who-text">
            <div className="activity-agent">
              {agentLine}
              {session.subagents > 0 && <span className="pill">{t('home.agents', { n: session.subagents })}</span>}
            </div>
            <div className={`status status--${session.status}`}>
              <span className="status-dot" />
              <span>{t(look.label)}</span>
              {busy && <span className="status-time">{duration(t, now - session.turnStartedAt)}</span>}
            </div>
          </div>
        </div>
        {steps}
        {stage !== null && <div className="activity-stage">{stage}</div>}
        {lane}
        {usage}
      </aside>
    )
  }

  return (
    <div className={`activity activity--bar ${open ? 'activity--open' : ''}`}>
      <button type="button" className="activity-line" onClick={() => setOpen(!open)} aria-expanded={open} title={t('activity.toggle')}>
        <Buddy pose={look.pose} mood={look.mood} tone={tone} size={26} />
        <span className={`status status--${session.status}`}>
          <span className="status-dot" />
          <span>{t(look.label)}</span>
        </span>
        <span className="activity-now">{headline === null ? '' : `${toolLabel(headline)} ${headline.title}`}</span>
        {busy && <span className="status-time">{duration(t, now - session.turnStartedAt)}</span>}
        <ChevronDownIcon size={16} className="activity-caret" />
      </button>
      {open && (
        <div className="activity-panel">
          {steps}
          {stage !== null && <div className="activity-stage">{stage}</div>}
          {lane}
          {usage}
        </div>
      )}
    </div>
  )
}
