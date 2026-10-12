import { useBackLayer } from './back.ts'
import { useI18n } from './i18n.ts'

// A short message at the bottom of the window, shown by App.
export function showToast(text: string): void {
  window.dispatchEvent(new CustomEvent('choibuddy-toast', { detail: text }))
}

type ConfirmProps = {
  title: string
  hint: string
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

// Asks before something that cannot be taken back, inside the app (a native
// dialog would block the WebView and look foreign).
export function ConfirmSheet({ title, hint, confirmLabel, busy = false, onConfirm, onCancel }: ConfirmProps) {
  const { t } = useI18n()

  useBackLayer(true, onCancel)

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet confirm-sheet" role="alertdialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
        <div className="confirm-body">
          <div className="sheet-title">{title}</div>
          <div className="confirm-hint">{hint}</div>
        </div>
        <footer className="sheet-actions">
          <button type="button" className="btn btn--deny" onClick={onCancel}>
            {t('action.cancel')}
          </button>
          <button type="button" className="btn btn--danger" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
