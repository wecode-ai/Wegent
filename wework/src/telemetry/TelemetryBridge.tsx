import { useEffect, useRef, useState } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { installTelemetry, setTelemetryEnabled, track } from './client'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { updateAppPreferences } from '@/tauri/appPreferences'
import { useTranslation } from '@/hooks/useTranslation'
import { TelemetryConsentDialog } from './TelemetryConsentDialog'

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
  const effectiveTelemetryEnabled = consentAsked === true && telemetryEnabled === true

  useEffect(() => {
    if (!appPreferences?.loaded || !consentAsked || initializedRef.current) {
      return
    }
    initializedRef.current = true
    void installTelemetry(effectiveTelemetryEnabled).then(() => {
      if (!effectiveTelemetryEnabled || startedRef.current) return
      startedRef.current = true
      track('app_started', { surface: appSurface() })
    })
  }, [appPreferences?.loaded, consentAsked, effectiveTelemetryEnabled])

  useEffect(() => {
    if (!appPreferences?.loaded || !consentAsked) return
    void setTelemetryEnabled(effectiveTelemetryEnabled)
  }, [appPreferences?.loaded, consentAsked, effectiveTelemetryEnabled])

  if (!appPreferences?.loaded || consentAsked || appSurface() !== 'main') {
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
