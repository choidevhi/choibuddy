import { useEffect, useState } from 'react'
import { renderSVG } from 'uqr'
import { type DeviceInfo, pairingLink, PROMPT_MODES, type PromptMode } from '../../shared/protocol.ts'
import { useBackLayer } from './back.ts'
import { showToast } from './confirm.tsx'
import { type Feed, readRemotes, saveRemotes } from './feeds.ts'
import { ago, duration, isLang, type Lang, LANGS, type MessageKey, type Translate, useI18n } from './i18n.ts'
import { CopyIcon, ScanIcon, ShieldIcon } from './icons.tsx'
import { createDevice, fetchSetup, listDevices, revokeDevice, rotateCodes, setAutoAccept, type SetupStatus } from './live.ts'
import { parsePairingLink, platform, windowsShell } from './platform.ts'
import { Picker } from './picker.tsx'
import { usePref } from './prefs.ts'

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
            <span className={`row-value ${setup.hooks ? 'good' : 'bad'}`}>{setup.hooks ? `✓ ${t('guide.ok')}` : t('guide.missing')}</span>
          </div>
          <div className="row">
            <span>{t('guide.mod')}</span>
            <span className={`row-value ${setup.mod ? 'good' : 'bad'}`}>{setup.mod ? `✓ ${t('guide.ok')}` : t('guide.missing')}</span>
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

// Auto Accept per PC. Turning it on always goes through an in-app
// confirmation that spells out what it does.
function DangerZone({ feeds, now }: { feeds: Feed[]; now: number }) {
  const { t } = useI18n()
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
}

const MODE_OPTION = {
  steer: 'mode.steer',
  queue: 'mode.queue',
  interrupt: 'mode.interrupt',
} as const satisfies Record<PromptMode, MessageKey>

export function Connect({ feeds, now, localFeed, prefs, onPrefs, onLang, onSourcesChanged }: ConnectProps) {
  const { lang, t } = useI18n()
  const [promptMode, setPromptMode] = usePref<PromptMode>('promptMode', PROMPT_MODES, 'steer')
  const [autostart, setAutostart] = useState<boolean | null>(null)
  const [doneAlerts, setDoneAlerts] = useState(() => window.ChoiBuddyNative?.doneAlerts() ?? true)
  const [notifications, setNotifications] = useState(() => window.ChoiBuddyNative?.notificationsAllowed() ?? true)

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
            options={PROMPT_MODES.map(mode => ({ value: mode, label: t(MODE_OPTION[mode]) }))}
            onChange={setPromptMode}
          />
        </div>
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
