import { useEffect, useMemo, useRef, useState } from 'react'
import { getAppPreferences } from '@/desktop/appPreferences'
import { TransientNotice } from '@/components/common/TransientNotice'
import { useTranslation } from '@/hooks/useTranslation'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { installTelemetry, isTelemetryEnabled, setTelemetryEnabled, track } from './client'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { TelemetryConsentDialog } from './TelemetryConsentDialog'
import { isOfficialReleaseBuild } from './config'
import {
  saveTelemetryConsent,
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
  const [failedChoice, setFailedChoice] = useState<boolean | null>(null)
  const [retrying, setRetrying] = useState(false)
  const appPreferences = useAppPreferencesState()
  const initializedRef = useRef(false)
  const startedRef = useRef(false)
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

  const choiceIsSaved =
    savedConsentAsked && appPreferences?.preferences.telemetryEnabled === failedChoice

  useEffect(() => {
    if (!appPreferences?.loaded || initializedRef.current) {
      return
    }
    if (officialRelease && !savedConsentAsked) return
    initializedRef.current = true
    void installTelemetry(effectiveTelemetryEnabled).then(() => {
      if (!effectiveTelemetryEnabled || !isTelemetryEnabled() || startedRef.current) return
      startedRef.current = true
      track('app_started', { surface })
    })
  }, [
    appPreferences?.loaded,
    savedConsentAsked,
    effectiveTelemetryEnabled,
    officialRelease,
    surface,
  ])

  useEffect(() => {
    if (!appPreferences?.loaded || (officialRelease && !savedConsentAsked)) {
      return
    }
    void setTelemetryEnabled(effectiveTelemetryEnabled).then(() => {
      // app_started marks the first point in this session where telemetry is
      // active: either right after app launch or after the user re-enables it.
      if (!effectiveTelemetryEnabled || startedRef.current) return
      startedRef.current = true
      track('app_started', { surface })
    })
  }, [
    appPreferences?.loaded,
    savedConsentAsked,
    effectiveTelemetryEnabled,
    officialRelease,
    surface,
  ])

  useEffect(() => {
    if (
      officialRelease ||
      !isElectronRuntime() ||
      !appPreferences?.loaded ||
      consentAsked === true
    ) {
      return
    }
    void saveTelemetryConsent(true, consentRevision).catch(error => {
      console.warn('[telemetry] Development consent persistence failed', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
    })
  }, [appPreferences?.loaded, consentAsked, consentRevision, officialRelease])

  const saveChoice = async (enabled: boolean, revision: number) => {
    try {
      await saveTelemetryConsent(enabled, revision)
      setFailedChoice(current => (current === enabled ? null : current))
    } catch (error) {
      if (isLatestTelemetryConsentChoice(enabled)) setFailedChoice(enabled)
      console.warn('[telemetry] Consent persistence failed; workbench remains available', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
    }
  }
  const retryChoice = async () => {
    if (failedChoice === null || retrying) return
    setRetrying(true)
    try {
      const current = await getAppPreferences()
      await saveChoice(failedChoice, current.telemetryConsentRevision)
    } catch (error) {
      console.warn('[telemetry] Consent retry could not read settings', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
    } finally {
      setRetrying(false)
    }
  }
  return (
    <>
      {appPreferences?.loaded && officialRelease && !consentAsked && surface === 'main' && (
        <TelemetryConsentDialog onChoose={enabled => void saveChoice(enabled, consentRevision)} />
      )}
      {failedChoice !== null &&
        !choiceIsSaved &&
        isLatestTelemetryConsentChoice(failedChoice) &&
        surface === 'main' && (
          <TransientNotice
            message={t('workbench.telemetry_consent_unsaved')}
            tone="error"
            onClear={() => setFailedChoice(null)}
            action={{
              label: t('workbench.retry'),
              testId: 'telemetry-consent-retry',
              onClick: () => void retryChoice(),
              pending: retrying,
            }}
          />
        )}
    </>
  )
}
