import { type RefObject, useEffect, useRef } from 'react'
import type { Agent } from '../../shared/protocol.ts'
import { agentPose, Buddy, type Tone, tintFor } from './buddy.tsx'
import { duration, useI18n } from './i18n.ts'
import { CheckIcon, SpinnerIcon } from './icons.tsx'
import { modelLabel } from './model.tsx'

function nowLine(agent: Agent): string {
  const running = agent.steps.findLast(step => step.status === 'running')

  if (running !== undefined) return `${running.tool} · ${running.title}`
  if (agent.status === 'done' && agent.message !== null) return agent.message.replace(/\s+/g, ' ').slice(0, 80)

  const last = agent.steps.at(-1)

  return last === undefined ? agent.description : `${last.tool} · ${last.title}`
}

// Moving further than this with the button down is a drag, not a click.
const DRAG_PX = 5

// Lets a mouse scroll a sideways strip: drag it, or turn the wheel over it.
// Touch scrolls it natively. A press that turned into a drag clicks nothing.
export function useDragScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current

    if (element === null) return

    let press: { x: number; left: number; dragged: boolean } | null = null
    let swallowClick = false

    const down = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      press = { x: event.clientX, left: element.scrollLeft, dragged: false }
      swallowClick = false
    }

    const move = (event: PointerEvent): void => {
      if (press === null) return

      const dx = event.clientX - press.x

      if (!press.dragged && Math.abs(dx) < DRAG_PX) return

      if (!press.dragged) {
        press.dragged = true
        element.setPointerCapture(event.pointerId)
        element.classList.add('dragging')
      }

      element.scrollLeft = press.left - dx
    }

    const up = (event: PointerEvent): void => {
      if (press?.dragged === true) {
        swallowClick = true
        element.releasePointerCapture(event.pointerId)
      }

      press = null
      element.classList.remove('dragging')
    }

    const click = (event: MouseEvent): void => {
      if (!swallowClick) return
      swallowClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    const wheel = (event: WheelEvent): void => {
      if (element.scrollWidth <= element.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      event.preventDefault()
      element.scrollLeft += event.deltaY
    }

    element.addEventListener('pointerdown', down)
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('pointercancel', up)
    element.addEventListener('click', click, true)
    element.addEventListener('wheel', wheel, { passive: false })

    return () => {
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('pointercancel', up)
      element.removeEventListener('click', click, true)
      element.removeEventListener('wheel', wheel)
    }
  }, [ref])
}

type LaneProps = {
  agents: Agent[]
  selectedId: string | null
  tone: Tone
  now: number
  onSelect: (id: string | null) => void
}

// Subagents as small coloured buddies under the stage, each with what it is
// doing right now. Picking one shows its own work on the stage.
export function AgentLane({ agents, selectedId, tone, now, onSelect }: LaneProps) {
  const { t } = useI18n()
  const lane = useRef<HTMLDivElement>(null)

  useDragScroll(lane)

  return (
    <div className={`agents ${agents.length === 0 ? 'agents--empty' : ''}`} ref={lane}>
      {agents.map(agent => {
        const look = agentPose(agent)
        const tint = tintFor(agent.id)
        const selected = agent.id === selectedId

        return (
          <button
            type="button"
            key={agent.id}
            className={`agent agent--${agent.status} ${selected ? 'selected' : ''}`}
            onClick={() => onSelect(selected ? null : agent.id)}
            title={agent.description}
          >
            <span className="agent-accent" style={{ background: tint }} />
            <Buddy pose={look.pose} mood={look.mood} tone={tone} tint={tint} size={30} />
            <span className="agent-text">
              <span className="agent-type">
                {agent.type === '' ? t('preview.agent') : agent.type}
                <span className="agent-time">{duration(t, (agent.endedAt ?? now) - agent.startedAt)}</span>
              </span>
              <span className="agent-now">{nowLine(agent)}</span>
              {agent.model !== null && <span className="agent-model">{modelLabel(agent.model)}</span>}
            </span>
            {agent.status === 'running' ? <SpinnerIcon size={13} className="agent-state" /> : <CheckIcon size={13} className="agent-state" />}
          </button>
        )
      })}
    </div>
  )
}
