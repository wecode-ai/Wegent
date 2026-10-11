import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { installTelemetry, isTelemetryEnabled, setTelemetryEnabled, track } from './client'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { useTranslation } from '@/hooks/useTranslation'
import { TelemetryConsentDialog } from './TelemetryConsentDialog'
import { getTelemetryConfig, isOfficialReleaseBuild } from './config'

function appSurface(): 'main' | 'popout' | 'workspace' {
  const label = isElectronRuntime() ? getDesktopWindowLabel() : 'main'
  if (label === 'popout-window') return 'popout'
  if (label?.startsWith('workspace-')) return 'workspace'
  return 'main'
}

// The consent save rides the renderer-to-host HTTP invoke, which can hang
// indefinitely (e.g. when Chromium's network service crashes mid-request).
// Bound the wait so the dialog surfaces a retryable error instead of
// deadlocking the full-screen modal.
const CONSENT_SAVE_TIMEOUT_MS = 10_000

export function TelemetryBridge() {
  const appPreferences = useAppPreferencesState()
  const { t } = useTranslation('common')
  const initializedRef = useRef(false)
  const startedRef = useRef(false)
  const [savingConsent, setSavingConsent] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)
  const pendingConsentSaveRef = useRef<Promise<unknown>>(Promise.resolve())
  const consentSaveGenerationRef = useRef(0)
  const latestConsentChoiceRef = useRef(false)
  const consentAsked = appPreferences?.preferences.telemetryConsentAsked
  const telemetryEnabled = appPreferences?.preferences.telemetryEnabled
  const distribution = getTelemetryConfig().distribution
  const officialRelease = isOfficialReleaseBuild()
  const effectiveTelemetryEnabled =
    !officialRelease && consentAsked !== true ? true : telemetryEnabled === true
  const surface = useMemo(() => appSurface(), [])

  useEffect(() => {
    if (!appPreferences?.loaded || initializedRef.current) {
      return
    }
    if (distribution === 'internal') {
      initializedRef.current = true
      void installTelemetry(false)
      return
    }
    if (officialRelease && !consentAsked) return
    initializedRef.current = true
    void installTelemetry(effectiveTelemetryEnabled).then(() => {
      if (!isTelemetryEnabled() || startedRef.current) return
      startedRef.current = true
      track('app_started', { surface })
    })
  }, [
    appPreferences?.loaded,
    consentAsked,
    distribution,
    effectiveTelemetryEnabled,
    officialRelease,
    surface,
  ])

  useEffect(() => {
    if (
      distribution === 'internal' ||
      !appPreferences?.loaded ||
      (officialRelease && !consentAsked)
    ) {
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
    consentAsked,
    distribution,
    effectiveTelemetryEnabled,
    officialRelease,
    surface,
  ])

  useEffect(() => {
    if (
      distribution === 'internal' ||
      officialRelease ||
      !isElectronRuntime() ||
      !appPreferences?.loaded ||
      consentAsked === true
    ) {
      return
    }
    void updateAppPreferences({
      telemetryConsentAsked: true,
      telemetryEnabled: true,
    })
  }, [appPreferences?.loaded, consentAsked, distribution, officialRelease])

  if (
    distribution === 'internal' ||
    !appPreferences?.loaded ||
    !officialRelease ||
    consentAsked ||
    surface !== 'main'
  ) {
    return null
  }

  const chooseConsent = async (enabled: boolean) => {
    setSavingConsent(true)
    setConsentError(null)
    latestConsentChoiceRef.current = enabled
    const generation = ++consentSaveGenerationRef.current
    // Serialize saves: a timed-out attempt may still be in flight, and a
    // parallel retry with a different value could be overwritten on disk and
    // in renderer state when the stale completion arrives last.
    const save = pendingConsentSaveRef.current
      .catch(() => {})
      .then(() =>
        updateAppPreferences({
          telemetryConsentAsked: true,
          telemetryEnabled: enabled,
        })
      )
      .finally(() => {
        // A superseded save may complete after a retry with a different
        // value; re-assert the latest choice once so the final state
        // converges to the user's intent.
        if (
          generation !== consentSaveGenerationRef.current &&
          latestConsentChoiceRef.current !== enabled
        ) {
          void updateAppPreferences({
            telemetryConsentAsked: true,
            telemetryEnabled: latestConsentChoiceRef.current,
          }).catch(() => {})
        }
      })
    pendingConsentSaveRef.current = save
    try {
      await raceWithTimeout(
        save,
        CONSENT_SAVE_TIMEOUT_MS,
        () => new Error('Timed out saving telemetry consent')
      )
    } catch {
      setConsentError(t('workbench.telemetry_consent_save_failed'))
      // Abandon the still in-flight save for chaining purposes so a retry
      // can start a fresh save instead of waiting on one that may never
      // settle.
      pendingConsentSaveRef.current = Promise.resolve()
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
