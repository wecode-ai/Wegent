import { ShieldCheck } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'

interface TelemetryConsentDialogProps {
  error: string | null
  saving: boolean
  onChoose: (enabled: boolean) => void
}

export function TelemetryConsentDialog({ error, saving, onChoose }: TelemetryConsentDialogProps) {
  const { t } = useTranslation('common')

  return createPortal(
    <div
      data-testid="telemetry-consent-overlay"
      className="fixed inset-0 z-system flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="telemetry-consent-title"
        aria-describedby="telemetry-consent-description"
        className="w-full max-w-[460px] rounded-2xl border border-border bg-background p-6 text-text-primary shadow-2xl"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <h2 id="telemetry-consent-title" className="mt-5 text-lg font-semibold">
          {t('workbench.telemetry_consent_title')}
        </h2>
        <p
          id="telemetry-consent-description"
          className="mt-2 text-sm leading-6 text-text-secondary"
        >
          {t('workbench.telemetry_consent_description')}
        </p>
        <p className="mt-3 rounded-xl bg-muted/60 px-3 py-2.5 text-xs leading-5 text-text-muted">
          {t('workbench.telemetry_consent_privacy')}
        </p>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            data-testid="telemetry-consent-decline"
            disabled={saving}
            onClick={() => onChoose(false)}
            className="h-10 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('workbench.telemetry_consent_decline')}
          </button>
          <button
            type="button"
            data-testid="telemetry-consent-accept"
            disabled={saving}
            onClick={() => onChoose(true)}
            className="h-10 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
          >
            {t('workbench.telemetry_consent_accept')}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
