import { useEffect, useMemo, useRef } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { installTelemetry, isTelemetryEnabled, setTelemetryEnabled, track } from './client'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { updateAppPreferences } from '@/desktop/appPreferences'

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
  const consentAsked = appPreferences?.preferences.telemetryConsentAsked
  const telemetryEnabled = appPreferences?.preferences.telemetryEnabled
  const effectiveTelemetryEnabled = consentAsked !== true ? true : telemetryEnabled === true
  const surface = useMemo(() => appSurface(), [])

  useEffect(() => {
    if (!appPreferences?.loaded || initializedRef.current) {
      return
    }
    initializedRef.current = true
    void installTelemetry(effectiveTelemetryEnabled).then(() => {
      if (!isTelemetryEnabled() || startedRef.current) return
      startedRef.current = true
      track('app_started', { surface })
    })
  }, [appPreferences?.loaded, effectiveTelemetryEnabled, surface])

  useEffect(() => {
    if (!appPreferences?.loaded) return
    void setTelemetryEnabled(effectiveTelemetryEnabled).then(() => {
      // app_started marks the first point in this session where telemetry is
      // active: either right after app launch or after the user re-enables it.
      if (!effectiveTelemetryEnabled || startedRef.current) return
      startedRef.current = true
      track('app_started', { surface })
    })
  }, [appPreferences?.loaded, effectiveTelemetryEnabled, surface])

  useEffect(() => {
    if (!isElectronRuntime() || !appPreferences?.loaded || consentAsked === true) {
      return
    }
    void updateAppPreferences({
      telemetryConsentAsked: true,
      telemetryEnabled: true,
    })
  }, [appPreferences?.loaded, consentAsked])

  return null
}
