import { useEffect, useState } from 'react'
import { renderSVG } from 'uqr'
import { type DeviceInfo, pairingLink, PICKED_MODES, type PromptMode } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { showToast } from './confirm.tsx'
import { type Feed, readRemotes, saveRemotes } from './feeds.ts'
import { ago, duration, isLang, type Lang, LANGS, type MessageKey, type Translate, useI18n } from './i18n.ts'
import { CheckIcon, CopyIcon, ScanIcon, ShieldIcon } from './icons.tsx'
import { type CodexState, createDevice, fetchCodex, fetchSetup, fetchTerms, listDevices, revokeDevice, rotateCodes, setAutoAccept, setAutoLanguage, setCodex, setRemoteTerminal, setTrustTailnet, type SetupStatus } from './live.ts'
import { isMac, parsePairingLink, platform, windowsShell } from './platform.ts'
import { Picker } from './picker.tsx'
import { usePref } from './prefs.ts'
import { openTerminalTab } from './terminal.tsx'
import { APP_VERSION, type UpdateState } from './update.tsx'

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="row">
      <span className="row-text">
        <span>{label}</span>
        {hint !== undefined && <span className="row-hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={on} onChange={event => onChange(event.target.checked)} />
    </label>
  )
}

function linkLabel(t: Translate, feed: Feed): string {
  switch (feed.link) {
    case 'live':
      return t('connect.live')
    case 'connecting':
      return t('connect.connecting')
    case 'unauthorized':
      return t('connect.unauthorized')
    case 'offline':
      return t('connect.offline')
  }
}

// This PC's bridge, managed with its own code: hand out a pairing code per
// device, see who is connected, cut one off, or cut everything at once.
function PairingManager({ feed, onSourcesChanged }: { feed: Feed; onSourcesChanged: () => void }) {
  const { t } = useI18n()
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const now = Date.now()
  const tailnetUrl = feed.snapshot?.server.tailnetUrl ?? null

  const refresh = (): void => void listDevices(feed.connection).then(setDevices)

  useEffect(() => {
    refresh()

    const timer = window.setInterval(refresh, 10_000)

    return () => window.clearInterval(timer)
    // Refreshing follows the PC's own connection only.
  }, [feed.connection.baseUrl, feed.connection.token])

  if (devices === null) return null

  const link = code === null || tailnetUrl === null ? null : pairingLink(tailnetUrl, code)

  return (
    <div className="card pairing-card">
      <div className="card-title">{t('connect.phone')}</div>
      {tailnetUrl === null ? (
        <>
          <div className="row-hint">{t('connect.tailscaleOff')}</div>
          <TailscaleRow />
        </>
      ) : link === null ? (
        <>
          <div className="row-hint">{t('connect.codeHint')}</div>
          <button
            type="button"
            className="btn btn--allow"
            onClick={() => {
              setCopied(false)
              void createDevice(feed.connection).then(token => {
                setCode(token)
                refresh()
              })
            }}
          >
            {t('connect.newCode')}
          </button>
        </>
      ) : (
        <div className="pairing">
          <div
            className="qr"
            // SVG generated locally from our own pairing link.
            dangerouslySetInnerHTML={{ __html: renderSVG(link, { border: 2, whiteColor: '#ffffff', blackColor: '#111114' }) }}
          />
          <div className="pairing-text">
            <div className="row-hint">{t('connect.codeHint')}</div>
            <div className="mono small">{tailnetUrl}</div>
            <div className="btn-row">
              <button type="button" className="btn small" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
                <CopyIcon size={14} /> {copied ? t('connect.copied') : t('connect.copy')}
              </button>
              <button type="button" className="btn small" onClick={() => setCode(null)}>
                {t('action.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="section-label devices-label">{t('connect.devices')}</div>
      {devices.length === 0 && <div className="row-hint">{t('connect.noDevices')}</div>}
      {devices.map(device => (
        <div className="row" key={device.id}>
          <span className="row-text">
            <span>{device.name === '' ? device.id : device.name}</span>
            <span className={`row-hint ${device.online ? 'good' : ''}`}>
              {device.online ? t('connect.online') : device.lastSeen === null ? t('connect.notUsed') : ago(t, now - device.lastSeen)}
            </span>
          </span>
          <button type="button" className="btn small btn--deny" onClick={() => void revokeDevice(feed.connection, device.id).then(refresh)}>
            {t('connect.revoke')}
          </button>
        </div>
      ))}

      <div className="row rotate-row">
        <span className="row-hint">
          {t('connect.rotateHint')} {t('connect.legacy')}
        </span>
        <button
          type="button"
          className="btn small btn--deny"
          onClick={() =>
            void rotateCodes(feed.connection).then(ok => {
              if (!ok) return
              setCode(null)
              onSourcesChanged()
            })
          }
        >
          {t('connect.rotate')}
        </button>
      </div>
    </div>
  )
}

type TailscaleState = 'installed' | 'missing' | 'installing'

function phoneTailscale(): TailscaleState | null {
  const installed = window.ChoiBuddyNative?.tailscaleInstalled?.()

  return installed === undefined ? null : installed ? 'installed' : 'missing'
}

// The phone and other PCs reach this PC through Tailscale. Puts it on this
// device in one tap (winget on Windows, the Play Store on the phone);
// signing in stays in Tailscale's own window or app.
function TailscaleRow() {
  const { t } = useI18n()
  const [state, setState] = useState<TailscaleState | null>(platform === 'android' ? phoneTailscale() : null)

  useEffect(() => {
    if (platform === 'windows') void windowsShell.tailscaleState().then(setState)
    if (platform !== 'android') return

    // Back from the Play Store: look again.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setState(phoneTailscale())
    }

    document.addEventListener('visibilitychange', onVisible)

    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  if (state === null) return null

  const install = async (): Promise<void> => {
    if (platform === 'android') {
      window.ChoiBuddyNative?.openTailscale?.()

      return
    }

    setState('installing')

    const ok = await windowsShell.installTailscale().catch(() => false)

    if (!ok) showToast(t('tailscale.installFailed'))
    setState(ok ? 'installed' : await windowsShell.tailscaleState().catch(() => 'missing' as const))
  }

  const open = (): void => {
    if (platform === 'android') window.ChoiBuddyNative?.openTailscale?.()
    else void windowsShell.openTailscale()
  }

  const hint =
    state === 'installing'
      ? t('tailscale.installing')
      : state === 'missing'
        ? t('tailscale.missing')
        : platform === 'android'
          ? t('tailscale.signInPhone')
          : t('tailscale.signInPc')

  return (
    <div className="row">
      <span className="row-text">
        <span>Tailscale</span>
        <span className="row-hint">{hint}</span>
      </span>
      {state === 'installed' ? (
        <button type="button" className="btn small" onClick={open}>
          {t('tailscale.open')}
        </button>
      ) : (
        <button type="button" className="btn small btn--allow" disabled={state === 'installing'} onClick={() => void install()}>
          {t('tailscale.install')}
        </button>
      )}
    </div>
  )
}

// Step-by-step pairing, with this PC's Claude Code wiring checked live.
function Guide({ localFeed }: { localFeed: Feed | null }) {
  const { t } = useI18n()
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (localFeed !== null) void fetchSetup(localFeed.connection).then(setSetup)
  }, [localFeed?.connection.token, localFeed?.link])

  const steps =
    platform === 'android'
      ? [t('guide.phone1'), t('guide.phone2'), t('guide.phone3'), t('guide.phone4')]
      : [t('guide.step1'), t('guide.step2'), t('guide.step3'), t('guide.step4'), t('guide.step5')]

  return (
    <div className="card guide">
      <div className="card-title">{t('guide.title')}</div>
      <ol className="guide-steps">
        {steps.map(step => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {platform === 'android' && <TailscaleRow />}
      {setup !== null && (
        <>
          <div className="row">
            <span>{t('guide.hooks')}</span>
            <span className={`row-value ${setup.hooks ? 'good' : 'bad'}`}>{setup.hooks ? <><CheckIcon size={13} /> {t('guide.ok')}</> : t('guide.missing')}</span>
          </div>
          <div className="row">
            <span>{t('guide.mod')}</span>
            <span className={`row-value ${setup.mod ? 'good' : 'bad'}`}>{setup.mod ? <><CheckIcon size={13} /> {t('guide.ok')}</> : t('guide.missing')}</span>
          </div>
          {platform === 'windows' && (
            <button
              type="button"
              className="btn small"
              disabled={installing}
              onClick={() => {
                setInstalling(true)
                void windowsShell
                  .installBridge()
                  .catch(() => false)
                  .then(() => {
                    setInstalling(false)
                    if (localFeed !== null) void fetchSetup(localFeed.connection).then(setSetup)
                  })
              }}
            >
              {installing ? t('setup.installing') : t('guide.reinstall')}
            </button>
          )}
        </>
      )}
      {platform === 'windows' && localFeed !== null && <CodexRow feed={localFeed} />}
    </div>
  )
}

// Codex on this PC: ChoiBuddy lists its hooks in Codex's hooks.json and has
// Codex trust them (as its /hooks screen would); Codex picks them up when it
// starts again.
// When connecting did not go through: Codex asks once, in its own terminal,
// whether to trust the hooks, and that answer settles it.
function CodexHelp({ feed, onClose }: { feed: Feed; onClose: () => void }) {
  const { t } = useI18n()

  useBackLayer(true, onClose)

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet confirm-sheet codex-help" role="dialog" aria-modal="true" aria-label={t('codexHelp.title')} onClick={event => event.stopPropagation()}>
        <div className="confirm-body">
          <div className="sheet-title">{t('codexHelp.title')}</div>
          <div className="confirm-hint">{t('codexHelp.why')}</div>
          <ol className="codex-steps">
            <li>{t('codexHelp.step1')}</li>
            <li>{t('codexHelp.step2')}</li>
            <li>{t('codexHelp.step3')}</li>
          </ol>
          <div className="row-hint">{t(isMac ? 'codexHelp.noCodexMac' : 'codexHelp.noCodex')}</div>
        </div>
        <footer className="sheet-actions">
          <button type="button" className="btn btn--deny" onClick={onClose}>
            {t('action.close')}
          </button>
          <button
            type="button"
            className="btn btn--allow"
            onClick={() => {
              openTerminalTab({ pcKey: feed.key, cwd: '', run: 'codex', prompt: '', title: '' })
              onClose()
            }}
          >
            {t('codexHelp.open')}
          </button>
        </footer>
      </div>
    </div>
  )
}

function CodexRow({ feed }: { feed: Feed }) {
  const { t } = useI18n()
  const [state, setState] = useState<CodexState | null>(null)
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)

  useEffect(() => {
    void fetchCodex(feed.connection).then(setState)
  }, [feed.connection.token])

  if (state === null) return null

  const change = async (on: boolean): Promise<void> => {
    setBusy(true)

    const next = await setCodex(feed.connection, on)

    setBusy(false)
    if (next !== null) setState(next)
    // Not connected, or Codex did not take the trust: the person does it once in Codex.
    if (on && (next === null || next.trusted !== true)) setHelp(true)
    else if (next === null) showToast(t('chat.actionFailed'))
  }

  // Connecting may first install the Codex CLI, which takes a while.
  const hint = busy
    ? t(state.cli ? 'codex.working' : 'codex.installing')
    : !state.connected
      ? `${t('codex.hint')}${state.cli ? '' : ` ${t(isMac ? 'codex.installHintMac' : 'codex.installHint')}`}`
      : state.trusted === true
        ? t('codex.ready')
        : t('codex.trust')

  return (
    <div className="row codex-row">
      <span className="row-text">
        <span>{t('codex.title')}</span>
        <span className={`row-hint ${state.connected && state.trusted === true ? 'good' : ''}`}>{hint}</span>
      </span>
      <span className="btn-row">
        {state.connected && state.trusted !== true && (
          <>
            <button type="button" className="btn small" disabled={busy} onClick={() => setHelp(true)}>
              {t('codexHelp.show')}
            </button>
            <button type="button" className="btn small btn--allow" disabled={busy} onClick={() => void change(true)}>
              {t('codex.retrust')}
            </button>
          </>
        )}
        <button type="button" className={`btn small ${state.connected ? '' : 'btn--allow'}`} disabled={busy} onClick={() => void change(!state.connected)}>
          {state.connected ? t('codex.disconnect') : t('codex.connect')}
        </button>
      </span>
      {help && <CodexHelp feed={feed} onClose={() => setHelp(false)} />}
    </div>
  )
}

// Windows: other PCs whose bridges this widget also watches.
function OtherPcs({ feeds, onSourcesChanged }: { feeds: Feed[]; onSourcesChanged: () => void }) {
  const { t } = useI18n()
  const [link, setLink] = useState('')
  const [error, setError] = useState(false)
  const remotes = feeds.filter(feed => !feed.local)

  const add = (): void => {
    const parsed = parsePairingLink(link)

    if (parsed === null) {
      setError(true)
      return
    }

    saveRemotes([...readRemotes().filter(remote => remote.baseUrl !== parsed.baseUrl), parsed])
    setLink('')
    setError(false)
    onSourcesChanged()
  }

  return (
    <div className="card">
      <div className="card-title">{t('connect.otherPcs')}</div>
      <div className="row-hint">{t('connect.otherPcsHint')}</div>
      {remotes.map(feed => (
        <div className="row" key={feed.key}>
          <span className="row-text">
            <span>{feed.snapshot?.server.hostName ?? feed.connection.baseUrl}</span>
            <span className={`row-hint ${feed.link === 'live' ? 'good' : 'bad'}`}>{linkLabel(t, feed)}</span>
          </span>
          <button
            type="button"
            className="btn small btn--deny"
            onClick={() => {
              saveRemotes(readRemotes().filter(remote => remote.baseUrl !== feed.connection.baseUrl))
              onSourcesChanged()
            }}
          >
            {t('connect.remove')}
          </button>
        </div>
      ))}
      <div className="btn-row">
        <input className="field" placeholder={t('connect.paste')} value={link} onChange={event => setLink(event.target.value)} />
        <button type="button" className="btn" disabled={link.trim() === ''} onClick={add}>
          {t('connect.addPc')}
        </button>
      </div>
      {error && <div className="row-hint bad">{t('connect.invalidLink')}</div>}
    </div>
  )
}

// Android: the PCs this phone is paired with.
function PhonePcs({ feeds }: { feeds: Feed[] }) {
  const { t } = useI18n()
  const [link, setLink] = useState('')
  const native = window.ChoiBuddyNative

  return (
    <div className="card">
      <div className="card-title">{t('connect.pcs')}</div>
      {feeds.length === 0 && <div className="row-hint">{t('connect.scanHint')}</div>}
      {feeds.map(feed => (
        <div className="row" key={feed.key}>
          <span className="row-text">
            <span>{feed.snapshot?.server.hostName ?? feed.connection.baseUrl}</span>
            <span className={`row-hint ${feed.link === 'live' ? 'good' : 'bad'}`}>
              {linkLabel(t, feed)} · {feed.connection.baseUrl}
            </span>
          </span>
          <button
            type="button"
            className="btn small btn--deny"
            onClick={() => (native?.removePairing === undefined ? native?.unpair() : native.removePairing(feed.connection.baseUrl))}
          >
            {t('connect.remove')}
          </button>
        </div>
      ))}
      <button type="button" className="btn btn--allow" onClick={() => native?.scanPairing()}>
        <ScanIcon size={16} /> {feeds.length === 0 ? t('connect.scan') : t('connect.scanAnother')}
      </button>
      <div className="btn-row">
        <input className="field" placeholder={t('connect.paste')} value={link} onChange={event => setLink(event.target.value)} />
        <button type="button" className="btn" disabled={link.trim() === ''} onClick={() => native?.setPairing(link.trim())}>
          {t('connect.pair')}
        </button>
      </div>
    </div>
  )
}

// How long Auto Accept stays on; a negative number means until turned off.
const AUTO_CHOICES = [
  { minutes: 30, label: 'danger.for30' },
  { minutes: 120, label: 'danger.for120' },
  { minutes: -1, label: 'danger.untilOff' },
] as const

// Further out than this means "until turned off".
const FOREVER_MS = 365 * 24 * 60 * 60_000

// This PC only: whether the person's own Tailscale devices connect without a
// code. Turning it on goes through a confirmation like Auto Accept.
function TrustTailnet({ feed }: { feed: Feed }) {
  const { t } = useI18n()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const on = feed.snapshot?.server.trustTailnet === true

  useBackLayer(asking, () => setAsking(false))

  const apply = async (next: boolean): Promise<void> => {
    setBusy(true)

    const ok = await setTrustTailnet(feed.connection, next)

    setBusy(false)
    setAsking(false)
    if (!ok) showToast(t('chat.actionFailed'))
  }

  return (
    <div className="danger-pc">
      <div className="row">
        <span className="row-text">
          <span className="danger-name">{t('danger.trust')}</span>
          <span className={`row-hint ${on ? 'bad' : ''}`}>{on ? t('danger.trustOn') : t('danger.trustHint')}</span>
        </span>
        {on ? (
          <button type="button" className="btn small btn--deny" disabled={busy} onClick={() => void apply(false)}>
            {t('danger.trustDisable')}
          </button>
        ) : (
          <button type="button" className={`btn small ${asking ? 'danger-picked' : ''}`} disabled={busy || feed.snapshot === null} onClick={() => setAsking(true)}>
            {t('danger.trustEnable')}
          </button>
        )}
      </div>
      {asking && !on && (
        <div className="danger-confirm" role="alertdialog" aria-label={t('danger.trust')}>
          <strong>{t('danger.trustAsk')}</strong>
          <span className="btn-row">
            <button type="button" className="btn small" onClick={() => setAsking(false)}>
              {t('danger.cancel')}
            </button>
            <button type="button" className="btn small btn--danger" disabled={busy} onClick={() => void apply(true)}>
              {t('danger.trustEnable')}
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

// This PC only: whether paired devices may use its terminals. A terminal
// runs whatever is typed into it, so turning it on is confirmed first.
function RemoteTerminal({ feed }: { feed: Feed }) {
  const { t } = useI18n()
  const [on, setOn] = useState<boolean | null>(null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)

  useBackLayer(asking, () => setAsking(false))

  useEffect(() => {
    void fetchTerms(feed.connection).then(state => setOn(state?.available === true ? state.remote : null))
  }, [feed.connection.token])

  if (on === null) return null

  const apply = async (next: boolean): Promise<void> => {
    setBusy(true)

    const ok = await setRemoteTerminal(feed.connection, next)

    setBusy(false)
    setAsking(false)
    if (ok) setOn(next)
    else showToast(t('chat.actionFailed'))
  }

  return (
    <div className="danger-pc">
      <div className="row">
        <span className="row-text">
          <span className="danger-name">{t('danger.terminal')}</span>
          <span className={`row-hint ${on ? 'bad' : ''}`}>{on ? t('danger.terminalOn') : t('danger.terminalHint')}</span>
        </span>
        {on ? (
          <button type="button" className="btn small btn--deny" disabled={busy} onClick={() => void apply(false)}>
            {t('danger.trustDisable')}
          </button>
        ) : (
          <button type="button" className={`btn small ${asking ? 'danger-picked' : ''}`} disabled={busy} onClick={() => setAsking(true)}>
            {t('danger.trustEnable')}
          </button>
        )}
      </div>
      {asking && !on && (
        <div className="danger-confirm" role="alertdialog" aria-label={t('danger.terminal')}>
          <strong>{t('danger.terminalAsk')}</strong>
          <span className="btn-row">
            <button type="button" className="btn small" onClick={() => setAsking(false)}>
              {t('danger.cancel')}
            </button>
            <button type="button" className="btn small btn--danger" disabled={busy} onClick={() => void apply(true)}>
              {t('danger.trustEnable')}
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

// Auto Accept per PC. Turning it on always goes through an in-app
// confirmation that spells out what it does.
function DangerZone({ feeds, now }: { feeds: Feed[]; now: number }) {
  const { t } = useI18n()
  const local = feeds.find(feed => feed.local)
  const [asking, setAsking] = useState<{ key: string; minutes: number } | null>(null)
  const [busy, setBusy] = useState(false)

  useBackLayer(asking !== null, () => setAsking(null))

  const apply = async (feed: Feed, minutes: number): Promise<void> => {
    setBusy(true)
    await setAutoAccept(feed.connection, minutes)
    setBusy(false)
    setAsking(null)
  }

  return (
    <div className="card danger">
      <div className="card-title danger-title">
        <ShieldIcon size={14} /> {t('danger.title')}
      </div>
      <div className="row-text">
        <span className="danger-name">{t('danger.autoAccept')}</span>
        <span className="row-hint">{t('danger.autoAcceptHint')}</span>
      </div>
      {feeds.map(feed => {
        const until = feed.snapshot?.server.autoAcceptUntil ?? 0
        const on = until > now
        const name = feed.local ? t('connect.thisPc') : (feed.snapshot?.server.hostName ?? feed.connection.baseUrl)
        const confirming = asking?.key === feed.key ? asking : null

        return (
          <div className="danger-pc" key={feed.key}>
            <div className="row">
              <span className="row-text">
                <span>{name}</span>
                {on && <span className="row-hint bad">{until - now > FOREVER_MS ? t('danger.onForever') : t('danger.on', { t: duration(t, until - now) })}</span>}
              </span>
              {on ? (
                <button type="button" className="btn small btn--deny" disabled={busy} onClick={() => void apply(feed, 0)}>
                  {t('danger.off')}
                </button>
              ) : (
                <span className="btn-row">
                  {AUTO_CHOICES.map(choice => (
                    <button
                      type="button"
                      key={choice.minutes}
                      className={`btn small ${confirming?.minutes === choice.minutes ? 'danger-picked' : ''}`}
                      disabled={busy || feed.snapshot === null}
                      onClick={() => setAsking({ key: feed.key, minutes: choice.minutes })}
                    >
                      {t(choice.label)}
                    </button>
                  ))}
                </span>
              )}
            </div>
            {confirming !== null && !on && (
              <div className="danger-confirm" role="alertdialog" aria-label={t('danger.confirmTitle')}>
                <strong>
                  {t('danger.confirmTitle')} · {t(AUTO_CHOICES.find(choice => choice.minutes === confirming.minutes)?.label ?? 'danger.untilOff')}
                </strong>
                <span className="btn-row">
                  <button type="button" className="btn small" onClick={() => setAsking(null)}>
                    {t('danger.cancel')}
                  </button>
                  <button type="button" className="btn small btn--danger" disabled={busy} onClick={() => void apply(feed, confirming.minutes)}>
                    {t('danger.confirm')}
                  </button>
                </span>
              </div>
            )}
          </div>
        )
      })}
      {local !== undefined && <TrustTailnet feed={local} />}
      {local !== undefined && <RemoteTerminal feed={local} />}
    </div>
  )
}

export type Prefs = {
  alwaysOnTop: boolean
  revealOnRequest: boolean
  keepScreenOn: boolean
  float: boolean
  progressBubbles: boolean
  doneBubbles: boolean
}

type ConnectProps = {
  feeds: Feed[]
  now: number
  localFeed: Feed | null
  prefs: Prefs
  onPrefs: (next: Prefs) => void
  onLang: (next: Lang) => void
  onSourcesChanged: () => void
  // A newer release, when there is one.
  update: UpdateState
  onUpdate: () => void
}

const MODE_OPTION = {
  steer: 'mode.steer',
  queue: 'mode.queue',
  interrupt: 'mode.interrupt',
} as const satisfies Record<PromptMode, MessageKey>

export function Connect({ feeds, now, localFeed, prefs, onPrefs, onLang, onSourcesChanged, update, onUpdate }: ConnectProps) {
  const { lang, t } = useI18n()
  const [promptMode, setPromptMode] = usePref<PromptMode>('promptMode', PICKED_MODES, 'steer')
  const [autostart, setAutostart] = useState<boolean | null>(null)
  const [doneAlerts, setDoneAlerts] = useState(() => window.ChoiBuddyNative?.doneAlerts() ?? true)
  const [notifications, setNotifications] = useState(() => window.ChoiBuddyNative?.notificationsAllowed() ?? true)
  // On when every connected PC asks again in this app's language.
  const autoLanguage = feeds.length > 0 && feeds.every(feed => feed.snapshot?.server.autoLanguage === lang)
  const langName = LANGS.find(item => item.id === lang)?.label ?? lang

  const changeAutoLanguage = async (on: boolean): Promise<void> => {
    const results = await Promise.all(feeds.map(feed => setAutoLanguage(feed.connection, on ? lang : null)))

    if (results.includes(false)) showToast(t('settings.autoLanguageFailed'))
  }

  useEffect(() => {
    if (platform === 'windows') void windowsShell.autostart().then(setAutostart, () => setAutostart(null))
  }, [])

  useEffect(() => {
    const refresh = (): void => setNotifications(window.ChoiBuddyNative?.notificationsAllowed() ?? true)

    window.addEventListener('focus', refresh)
    window.addEventListener('choibuddy-notifications', refresh)

    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('choibuddy-notifications', refresh)
    }
  }, [])

  return (
    <div className="connect">
      <Guide localFeed={localFeed} />
      {platform === 'android' && <PhonePcs feeds={feeds} />}
      {localFeed !== null && <PairingManager feed={localFeed} onSourcesChanged={onSourcesChanged} />}
      {platform === 'windows' && <OtherPcs feeds={feeds} onSourcesChanged={onSourcesChanged} />}

      <div className="card">
        <div className="card-title">{t('connect.status')}</div>
        {feeds.map(feed => (
          <div className="row" key={feed.key}>
            <span>{feed.local ? t('connect.thisPc') : (feed.snapshot?.server.hostName ?? feed.connection.baseUrl)}</span>
            <span className={`row-value ${feed.link === 'live' ? 'good' : 'bad'}`}>
              {linkLabel(t, feed)}
              {feed.snapshot !== null && ` · ${feed.snapshot.server.hostName} · v${feed.snapshot.server.version}`}
            </span>
          </div>
        ))}
        {platform === 'android' && !notifications && (
          <div className="row">
            <span className="row-text">
              <span>{t('connect.notificationsOff')}</span>
              <span className="row-hint">{t('connect.notificationsHint')}</span>
            </span>
            <button type="button" className="btn small" onClick={() => window.ChoiBuddyNative?.requestNotifications()}>
              {t('connect.enable')}
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">{t('settings.title')}</div>
        <div className="row">
          <span className="row-text">
            <span>{t('update.appVersion')}</span>
            <span className="row-hint">
              {update.release === null ? t('update.latest', { v: APP_VERSION }) : t('update.available', { v: update.release.version, current: APP_VERSION })}
              {update.checkedAt > 0 && ` · ${t('update.checked', { when: ago(t, now - update.checkedAt) })}`}
            </span>
          </span>
          {update.release !== null ? (
            <button type="button" className="btn small btn--allow" onClick={onUpdate}>
              {t('update.confirm')}
            </button>
          ) : (
            <button
              type="button"
              className="btn small"
              disabled={update.checking}
              onClick={() =>
                void update.check().then(reached => {
                  if (!reached) showToast(t('update.checkFailed'))
                })
              }
            >
              {update.checking ? t('update.checking') : t('update.check')}
            </button>
          )}
        </div>
        <div className="row">
          <span>{t('settings.language')}</span>
          <Picker
            className="select"
            value={lang}
            title={t('settings.language')}
            options={LANGS.map(item => ({ value: item.id, label: item.label }))}
            onChange={next => {
              if (isLang(next)) onLang(next)
            }}
          />
        </div>
        <div className="row">
          <span className="row-text">
            <span>{t('settings.promptMode')}</span>
            <span className="row-hint">{t('settings.promptModeHint')}</span>
          </span>
          <Picker
            className="select"
            value={promptMode}
            title={t('settings.promptMode')}
            options={PICKED_MODES.map(mode => ({ value: mode, label: t(MODE_OPTION[mode]) }))}
            onChange={setPromptMode}
          />
        </div>
        <Toggle
          label={t('settings.autoLanguage')}
          hint={t('settings.autoLanguageHint', { lang: langName })}
          on={autoLanguage}
          onChange={on => void changeAutoLanguage(on)}
        />
        {platform === 'windows' && (
          <>
            <Toggle label={t('settings.float')} hint={t('settings.floatHint')} on={prefs.float} onChange={on => onPrefs({ ...prefs, float: on })} />
            {prefs.float && (
              <>
                <div className="row">
                  <span />
                  <button type="button" className="btn small" onClick={() => void windowsShell.resetFloat()}>
                    {t('settings.resetFloat')}
                  </button>
                </div>
                <Toggle label={t('settings.progressBubbles')} on={prefs.progressBubbles} onChange={on => onPrefs({ ...prefs, progressBubbles: on })} />
                <Toggle label={t('settings.doneBubbles')} on={prefs.doneBubbles} onChange={on => onPrefs({ ...prefs, doneBubbles: on })} />
              </>
            )}
            <Toggle label={t('settings.alwaysOnTop')} on={prefs.alwaysOnTop} onChange={on => onPrefs({ ...prefs, alwaysOnTop: on })} />
            <Toggle label={t('settings.reveal')} on={prefs.revealOnRequest} onChange={on => onPrefs({ ...prefs, revealOnRequest: on })} />
            {autostart !== null && (
              <Toggle
                label={t('settings.autostart')}
                hint={t('settings.autostartHint')}
                on={autostart}
                onChange={on => void windowsShell.setAutostart(on).then(() => setAutostart(on))}
              />
            )}
          </>
        )}
        {platform === 'android' && (
          <>
            <Toggle label={t('settings.keepScreenOn')} hint={t('settings.keepScreenOnHint')} on={prefs.keepScreenOn} onChange={on => onPrefs({ ...prefs, keepScreenOn: on })} />
            <Toggle
              label={t('settings.doneAlerts')}
              hint={t('settings.doneAlertsHint')}
              on={doneAlerts}
              onChange={on => {
                window.ChoiBuddyNative?.setDoneAlerts(on)
                setDoneAlerts(on)
              }}
            />
            {window.ChoiBuddyNative?.pinWidget !== undefined && (
              <div className="row">
                <span className="row-text">
                  <span>{t('settings.widget')}</span>
                  <span className="row-hint">{t('settings.widgetHint')}</span>
                </span>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    if (window.ChoiBuddyNative?.pinWidget?.() !== true) showToast(t('settings.widgetManual'))
                  }}
                >
                  {t('settings.widgetAdd')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <DangerZone feeds={feeds} now={now} />
    </div>
  )
}
