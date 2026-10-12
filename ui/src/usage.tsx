import type { ReactNode } from 'react'
import type { Limits, RateLimit, SessionUsage } from '../../shared/protocol.ts'
import { duration, type MessageKey, type Translate, useI18n } from './i18n.ts'

export type Gauge = {
  key: string
  label: string
  percent: number | null
  value: string
  hint: string | null
}

function level(percent: number | null): 'ok' | 'warn' | 'bad' {
  if (percent === null || percent < 60) return 'ok'

  return percent < 85 ? 'warn' : 'bad'
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`

  return String(value)
}

function windowGauge(t: Translate, limit: RateLimit | undefined, label: MessageKey, now: number): Gauge | null {
  if (limit === undefined) return null

  const resetAt = limit.resetsAt === null ? Number.NaN : Date.parse(limit.resetsAt)
  // A window that has already reset reads as empty until the next reading.
  const expired = Number.isFinite(resetAt) && resetAt <= now
  const percent = expired ? 0 : limit.percentUsed

  return {
    key: limit.kind,
    label: t(label),
    percent,
    value: `${Math.round(percent)}%`,
    hint: !expired && Number.isFinite(resetAt) ? duration(t, resetAt - now) : null,
  }
}

export function gauges(t: Translate, usage: SessionUsage | null, limits: Limits | null, now: number): Gauge[] {
  const windows = limits?.windows ?? []
  const out: Gauge[] = []
  const fiveHour = windowGauge(t, windows.find(limit => limit.kind === 'five_hour'), 'usage.fiveHour', now)
  const sevenDay = windowGauge(t, windows.find(limit => limit.kind === 'seven_day'), 'usage.sevenDay', now)

  if (fiveHour !== null) out.push(fiveHour)
  if (sevenDay !== null) out.push(sevenDay)
  if (usage === null) return out

  if (usage.contextPercent !== null) {
    out.push({ key: 'context', label: t('usage.context'), percent: usage.contextPercent, value: `${Math.round(usage.contextPercent)}%`, hint: null })
  }

  const cacheable = usage.cacheReadTokens + usage.cacheWriteTokens + usage.inputTokens
  const total = cacheable + usage.outputTokens

  if (cacheable > 0) {
    const rate = (usage.cacheReadTokens / cacheable) * 100

    out.push({ key: 'cache', label: t('usage.cache'), percent: null, value: `${Math.round(rate)}%`, hint: null })
  }

  if (total > 0) out.push({ key: 'tokens', label: t('usage.tokens'), percent: null, value: compactNumber(total), hint: null })

  return out
}

type StripProps = {
  usage: SessionUsage | null
  limits: Limits | null
  now: number
  // Drawn first: the model and effort control.
  lead?: ReactNode
}

export function UsageStrip({ usage, limits, now, lead = null }: StripProps) {
  const { t } = useI18n()
  const items = gauges(t, usage, limits, now)

  if (items.length === 0 && lead === null) return null

  return (
    <div className="usage">
      {lead}
      {items.map(item => (
        <div className={`gauge gauge--${level(item.percent)}`} key={item.key} title={item.hint ?? undefined}>
          <span className="gauge-label">{item.label}</span>
          {item.percent !== null && (
            <span className="gauge-bar">
              <span className="gauge-fill" style={{ width: `${Math.min(100, Math.max(2, item.percent))}%` }} />
            </span>
          )}
          <span className="gauge-value">{item.value}</span>
          {item.hint !== null && <span className="gauge-hint">{item.hint}</span>}
        </div>
      ))}
    </div>
  )
}
