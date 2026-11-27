import { useTranslation } from '@/hooks/useTranslation'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ShieldCheck } from 'lucide-react'
import { getTelemetryConfig } from './config'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TelemetryCollectionNotice } from './TelemetryCollectionNotice'

interface TelemetryConsentDialogProps {
  onChoose: (enabled: boolean, details?: boolean) => void
}

export function TelemetryConsentDialog({ onChoose }: TelemetryConsentDialogProps) {
  const { t } = useTranslation('common')
  const config = getTelemetryConfig()
  const [details, setDetails] = useState(
    import.meta.env.VITE_WEWORK_DETAILED_TELEMETRY_DEFAULT === 'true'
  )
  const sectionRef = useRef<HTMLElement>(null)

  return createPortal(
    <div
      data-testid="telemetry-consent-overlay"
      className="fixed inset-0 z-system flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
    >
      <DialogSurface
        initialFocus='[data-testid="telemetry-consent-accept"]'
        render={
          <section
            ref={sectionRef}
            aria-labelledby="telemetry-consent-title"
            aria-describedby="telemetry-consent-description"
            className="w-full max-w-[460px] rounded-2xl border border-border bg-background p-6 text-text-primary shadow-2xl"
          />
        }
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
        <TelemetryCollectionNotice />
        {config.posthogKey && (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="telemetry-consent-details"
              checked={details}
              onChange={event => setDetails(event.currentTarget.checked)}
            />
            <span>
              {t('workbench.detailed_telemetry_enabled')} —{' '}
              {t('workbench.detailed_telemetry_description', { host: config.posthogHost })}
            </span>
          </label>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid="telemetry-consent-decline"
            onClick={() => onChoose(false)}
            className="h-10 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('workbench.telemetry_consent_decline')}
          </ControlButton>
          <ControlButton
            variant="primary"
            size="sm"
            type="button"
            autoFocus
            data-testid="telemetry-consent-accept"
            onClick={() => onChoose(true, Boolean(config.posthogKey) && details)}
            className="h-10 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
          >
            {t('workbench.telemetry_consent_accept')}
          </ControlButton>
        </div>
      </DialogSurface>
    </div>,
    document.body
  )
}
