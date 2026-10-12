import type { Agent, Session, StepKind } from '../../shared/protocol.ts'
import type { MessageKey } from './i18n.ts'
import type { LinkState } from './live.ts'

export type Pose =
  | 'base'
  | 'think'
  | 'sleepy'
  | 'closed'
  | 'happy'
  | 'read'
  | 'search'
  | 'edit'
  | 'write'
  | 'bash'
  | 'web'
  | 'agent'
  | 'todo'
  | 'mcp'
  | 'question'
  | 'plan'
  | 'warning'
  | 'failed'
  | 'celebrate'
  | 'done'
  | 'dizzy'
  | 'coffee'
  | 'shrug'
  | 'denied'
  | 'wave'

export type Mood = 'calm' | 'busy' | 'alert' | 'happy' | 'sleep'

export type Look = {
  pose: Pose
  mood: Mood
  label: MessageKey
}

export type Tone = 'white' | 'black'

const white = import.meta.glob<string>('./assets/character/white/*.svg', { query: '?raw', import: 'default', eager: true })
const black = import.meta.glob<string>('./assets/character/black/*.svg', { query: '?raw', import: 'default', eager: true })

// Subagents get their own colour so several can sit side by side.
export const AGENT_TINTS = ['#7aa2ff', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#22d3ee'] as const

export function tintFor(id: string): string {
  let hash = 0

  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0

  return AGENT_TINTS[hash % AGENT_TINTS.length] ?? AGENT_TINTS[0]
}

function svgFor(pose: Pose, tone: Tone, tint: string | null): string {
  // A tinted body keeps the light variant's dark eyes, which read on any colour.
  const variant = tint === null ? tone : 'white'
  const source = (variant === 'white' ? white : black)[`./assets/character/${variant}/${pose}.svg`] ?? ''
  const sized = source.replace(/ width="\d+" height="\d+"/, '')

  return tint === null ? sized : sized.replace(/(class="m-body"[^>]*?style="fill:)#[0-9a-fA-F]{6}/, `$1${tint}`)
}

const WORKING: Record<StepKind, { pose: Pose; label: MessageKey }> = {
  read: { pose: 'read', label: 'look.read' },
  edit: { pose: 'edit', label: 'look.edit' },
  write: { pose: 'write', label: 'look.write' },
  bash: { pose: 'bash', label: 'look.bash' },
  search: { pose: 'search', label: 'look.search' },
  web: { pose: 'web', label: 'look.web' },
  agent: { pose: 'agent', label: 'look.agent' },
  todo: { pose: 'todo', label: 'look.todo' },
  question: { pose: 'question', label: 'look.question' },
  plan: { pose: 'plan', label: 'look.plan' },
  mcp: { pose: 'mcp', label: 'look.mcp' },
  other: { pose: 'write', label: 'look.other' },
}

export function agentPose(agent: Agent): { pose: Pose; mood: Mood } {
  if (agent.status === 'done') return { pose: 'done', mood: 'calm' }

  const running = agent.steps.findLast(step => step.status === 'running')

  return running === undefined ? { pose: 'think', mood: 'busy' } : { pose: WORKING[running.kind].pose, mood: 'busy' }
}

const CELEBRATE_MS = 20_000
const DROWSY_MS = 15 * 60_000

export function lookFor(session: Session | null, link: LinkState, now: number): Look {
  if (link === 'offline' || link === 'unauthorized') return { pose: 'shrug', mood: 'calm', label: link === 'offline' ? 'look.offline' : 'look.unauthorized' }
  if (session === null) return { pose: 'coffee', mood: 'calm', label: 'look.resting' }

  const quiet = now - session.updatedAt
  const last = session.steps.at(-1)

  switch (session.status) {
    case 'waiting':
      return { pose: 'warning', mood: 'alert', label: 'look.waiting' }
    case 'thinking':
      return { pose: 'think', mood: 'busy', label: 'look.thinking' }
    case 'working': {
      const running = session.steps.findLast(step => step.status === 'running')

      if (running === undefined && last?.status === 'failed') return { pose: 'failed', mood: 'alert', label: 'look.failed' }

      const working = WORKING[running?.kind ?? last?.kind ?? 'other']

      return { pose: working.pose, mood: 'busy', label: working.label }
    }
    case 'done':
      if (quiet < CELEBRATE_MS) return { pose: 'celebrate', mood: 'happy', label: 'look.celebrate' }
      if (quiet > DROWSY_MS) return { pose: 'sleepy', mood: 'sleep', label: 'look.resting' }

      return { pose: 'done', mood: 'calm', label: 'look.done' }
    case 'error':
      return { pose: 'dizzy', mood: 'alert', label: 'look.error' }
    case 'ended':
      return { pose: 'closed', mood: 'sleep', label: 'look.ended' }
    case 'idle':
      return quiet > DROWSY_MS ? { pose: 'sleepy', mood: 'sleep', label: 'look.resting' } : { pose: 'base', mood: 'calm', label: 'look.idle' }
  }
}

// Without a size the surrounding CSS decides how big the character is.
type BuddyProps = {
  pose: Pose
  mood: Mood
  tone: Tone
  size?: number
  tint?: string
}

export function Buddy({ pose, mood, tone, size, tint }: BuddyProps) {
  return (
    <div
      key={pose}
      className={`buddy buddy--${mood}`}
      style={size === undefined ? undefined : { width: size, height: size }}
      role="img"
      aria-label="ChoiBuddy"
      // Bundled SVG assets from the repo, never data from the bridge.
      dangerouslySetInnerHTML={{ __html: svgFor(pose, tone, tint ?? null) }}
    />
  )
}
