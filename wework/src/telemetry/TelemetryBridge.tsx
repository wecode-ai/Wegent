import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { TransientNotice } from '@/components/common/TransientNotice'
import { useTranslation } from '@/hooks/useTranslation'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { createTelemetryConsentSource } from './telemetryConsentSource'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { TelemetryConsentDialog } from './TelemetryConsentDialog'
import { isOfficialReleaseBuild } from './config'
import {
  isLatestTelemetryConsentChoice,
  useSessionTelemetryConsent,
  useSessionTelemetryConsentAsked,
} from './sessionConsent'

function appSurface(): 'main' | 'popout' | 'workspace' {
  const label = isElectronRuntime() ? getDesktopWindowLabel() : 'main'
  if (label === 'popout-window') return 'popout'
  if (label?.startsWith('workspace-')) return 'workspace'
  return 'main'
}

export function TelemetryBridge() {
  const { t } = useTranslation('common')
  const [consent] = useState(createTelemetryConsentSource)
  const appPreferences = useAppPreferencesState()
  const sessionConsent = useSessionTelemetryConsent()
  const sessionAsked = useSessionTelemetryConsentAsked()
  // Dismiss the prompt immediately, but initialize collection only from saved consent.
  const savedConsentAsked = appPreferences?.preferences.telemetryConsentAsked === true
  const consentRevision = appPreferences?.preferences.telemetryConsentRevision ?? 0
  const consentAsked = sessionAsked || savedConsentAsked
  // A session opt-in must not override a refusal saved by another window.
  const telemetryEnabled =
    sessionConsent !== false &&
    appPreferences?.preferences.telemetryConsentAsked === true &&
    appPreferences.preferences.telemetryEnabled === true
  const officialRelease = isOfficialReleaseBuild()
  const effectiveTelemetryEnabled =
    !officialRelease && consentAsked !== true ? true : telemetryEnabled === true
  const surface = useMemo(() => appSurface(), [])

  const electronRuntime = isElectronRuntime()
  const subscribe = useCallback(
    (listener: () => void) =>
      consent.subscribe(listener, {
        loaded: appPreferences?.loaded === true,
        savedConsentAsked,
        consentAsked,
        consentRevision,
        enabled: effectiveTelemetryEnabled,
        officialRelease,
        electronRuntime,
        surface,
      }),
    [
      consent,
      appPreferences?.loaded,
      savedConsentAsked,
      consentAsked,
      consentRevision,
      effectiveTelemetryEnabled,
      officialRelease,
      electronRuntime,
      surface,
    ]
  )
  const { failedChoice, retrying } = useSyncExternalStore(subscribe, consent.getSnapshot)
  const choiceIsSaved =
    savedConsentAsked && appPreferences?.preferences.telemetryEnabled === failedChoice
  return (
    <>
      {appPreferences?.loaded && officialRelease && !consentAsked && surface === 'main' && (
        <TelemetryConsentDialog onChoose={consent.choose} />
      )}
      {failedChoice !== null &&
        !choiceIsSaved &&
        isLatestTelemetryConsentChoice(failedChoice) &&
        surface === 'main' && (
          <TransientNotice
            message={t('workbench.telemetry_consent_unsaved')}
            tone="error"
            onClear={consent.clearFailure}
            action={{
              label: t('workbench.retry'),
              testId: 'telemetry-consent-retry',
              onClick: () => void consent.retry(),
              pending: retrying,
            }}
          />
        )}
    </>
  )
}
