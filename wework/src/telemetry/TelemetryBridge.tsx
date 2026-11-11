import { useEffect, useMemo, useRef } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { installTelemetry, isTelemetryEnabled, setTelemetryEnabled, track } from './client'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { TelemetryConsentDialog } from './TelemetryConsentDialog'
import { isOfficialReleaseBuild } from './config'
import {
  saveTelemetryConsent,
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
  const appPreferences = useAppPreferencesState()
  const initializedRef = useRef(false)
  const startedRef = useRef(false)
  const sessionConsent = useSessionTelemetryConsent()
  const sessionAsked = useSessionTelemetryConsentAsked()
  // Dismiss the prompt immediately, but initialize collection only from saved consent.
  const savedConsentAsked = appPreferences?.preferences.telemetryConsentAsked === true
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
    void saveTelemetryConsent(true).catch(error => {
      console.warn('[telemetry] Development consent persistence failed', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
    })
  }, [appPreferences?.loaded, consentAsked, officialRelease])

  if (!appPreferences?.loaded || !officialRelease || consentAsked || surface !== 'main') {
    return null
  }

  return (
    <TelemetryConsentDialog
      onChoose={enabled => {
        void saveTelemetryConsent(enabled).catch(error => {
          console.warn('[telemetry] Consent persistence failed; workbench remains available', {
            errorType: error instanceof Error ? error.name : typeof error,
          })
        })
      }}
    />
  )
}
