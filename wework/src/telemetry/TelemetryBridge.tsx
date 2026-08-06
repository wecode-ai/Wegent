import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { installTelemetry, isTelemetryEnabled, setTelemetryEnabled, track } from './client'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { updateAppPreferences } from '@/tauri/appPreferences'
import { useTranslation } from '@/hooks/useTranslation'
import { TelemetryConsentDialog } from './TelemetryConsentDialog'
import { isOfficialReleaseBuild } from './config'

function appSurface(): 'main' | 'popout' | 'workspace' {
  const label = isTauriRuntime() ? getCurrentWindow().label : 'main'
  if (label === 'popout-window') return 'popout'
  if (label?.startsWith('workspace-')) return 'workspace'
  return 'main'
}

export function TelemetryBridge() {
  const appPreferences = useAppPreferencesState()
  const { t } = useTranslation('common')
  const initializedRef = useRef(false)
  const startedRef = useRef(false)
  const [savingConsent, setSavingConsent] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)
  const consentAsked = appPreferences?.preferences.telemetryConsentAsked
  const telemetryEnabled = appPreferences?.preferences.telemetryEnabled
  const officialRelease = isOfficialReleaseBuild()
  const effectiveTelemetryEnabled =
    !officialRelease && consentAsked !== true ? true : telemetryEnabled === true
  const surface = useMemo(() => appSurface(), [])

  useEffect(() => {
    if (!appPreferences?.loaded || (officialRelease && !consentAsked) || initializedRef.current) {
      return
    }
    initializedRef.current = true
    void installTelemetry(effectiveTelemetryEnabled).then(() => {
      if (!isTelemetryEnabled() || startedRef.current) return
      startedRef.current = true
      track('app_started', { surface })
    })
  }, [appPreferences?.loaded, consentAsked, effectiveTelemetryEnabled, officialRelease, surface])

  useEffect(() => {
    if (!appPreferences?.loaded || (officialRelease && !consentAsked)) return
    void setTelemetryEnabled(effectiveTelemetryEnabled).then(() => {
      // app_started marks the first point in this session where telemetry is
      // active: either right after app launch or after the user re-enables it.
      if (!effectiveTelemetryEnabled || startedRef.current) return
      startedRef.current = true
      track('app_started', { surface })
    })
  }, [appPreferences?.loaded, consentAsked, effectiveTelemetryEnabled, officialRelease, surface])

  useEffect(() => {
    if (officialRelease || !isTauriRuntime() || !appPreferences?.loaded || consentAsked === true) {
      return
    }
    void updateAppPreferences({
      telemetryConsentAsked: true,
      telemetryEnabled: true,
    })
  }, [appPreferences?.loaded, consentAsked, officialRelease])

  if (!appPreferences?.loaded || !officialRelease || consentAsked || surface !== 'main') {
    return null
  }

  const chooseConsent = async (enabled: boolean) => {
    setSavingConsent(true)
    setConsentError(null)
    try {
      await updateAppPreferences({
        telemetryConsentAsked: true,
        telemetryEnabled: enabled,
      })
    } catch {
      setConsentError(t('workbench.telemetry_consent_save_failed'))
    } finally {
      setSavingConsent(false)
    }
  }

  return (
    <TelemetryConsentDialog
      error={consentError}
      saving={savingConsent}
      onChoose={enabled => void chooseConsent(enabled)}
    />
  )
}
