import { getAppPreferences } from '@/desktop/appPreferences'
import { installTelemetry, isTelemetryEnabled, setTelemetryEnabled, track } from './client'
import { isLatestTelemetryConsentChoice, saveTelemetryConsent } from './sessionConsent'

export interface TelemetryConsentInput {
  loaded: boolean
  savedConsentAsked: boolean
  consentAsked: boolean
  consentRevision: number
  enabled: boolean
  officialRelease: boolean
  electronRuntime: boolean
  surface: 'main' | 'popout' | 'workspace'
}

interface ConsentSnapshot {
  failedChoice: boolean | null
  retrying: boolean
}

/** Own saved-consent synchronization and the visible persistence recovery state. */
export function createTelemetryConsentSource() {
  let snapshot: ConsentSnapshot = { failedChoice: null, retrying: false }
  let input: TelemetryConsentInput | null = null
  let initialized = false
  let started = false
  let appliedEnabled: boolean | undefined
  let developmentRevision: number | undefined
  let ready = false
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<ConsentSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const report = (message: string, error: unknown) => {
    console.warn(message, { errorType: error instanceof Error ? error.name : typeof error })
  }
  const acknowledgeStarted = () => {
    const current = input
    if (
      !ready ||
      !listeners.size ||
      !current?.loaded ||
      !current.enabled ||
      (current.officialRelease && !current.savedConsentAsked) ||
      !isTelemetryEnabled() ||
      started
    )
      return
    started = true
    track('app_started', { surface: current.surface })
  }
  const transitionCompleted = () => {
    ready = true
    acknowledgeStarted()
  }
  const synchronize = (current: TelemetryConsentInput) => {
    input = current
    if (!current.loaded) return
    if (!current.officialRelease || current.savedConsentAsked) {
      if (!initialized) {
        initialized = true
        void installTelemetry(current.enabled)
          .then(transitionCompleted)
          .catch(error => report('[telemetry] Initialization failed', error))
      }
      if (appliedEnabled !== current.enabled) {
        appliedEnabled = current.enabled
        void setTelemetryEnabled(current.enabled)
          .then(transitionCompleted)
          .catch(error => report('[telemetry] Preference synchronization failed', error))
      }
    }
    acknowledgeStarted()
    if (
      !current.officialRelease &&
      current.electronRuntime &&
      !current.consentAsked &&
      developmentRevision !== current.consentRevision
    ) {
      developmentRevision = current.consentRevision
      void saveTelemetryConsent(true, current.consentRevision).catch(error => {
        report('[telemetry] Development consent persistence failed', error)
      })
    }
  }
  let chosenDetails: boolean | undefined
  const saveChoice = async (enabled: boolean, expectedRevision: number) => {
    try {
      await saveTelemetryConsent(enabled, expectedRevision, chosenDetails)
      if (snapshot.failedChoice === enabled) publish({ failedChoice: null })
    } catch (error) {
      if (isLatestTelemetryConsentChoice(enabled)) publish({ failedChoice: enabled })
      report('[telemetry] Consent persistence failed; workbench remains available', error)
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, current: TelemetryConsentInput) {
      listeners.add(listener)
      synchronize(current)
      return () => {
        listeners.delete(listener)
        // A same-commit metadata handoff retains ownership of pending initialization.
        queueMicrotask(() => {
          if (listeners.size) return
          input = null
        })
      }
    },
    choose(enabled: boolean, details?: boolean) {
      chosenDetails = details
      if (input) void saveChoice(enabled, input.consentRevision)
    },
    clearFailure() {
      publish({ failedChoice: null })
    },
    async retry() {
      if (snapshot.failedChoice === null || snapshot.retrying) return
      const choice = snapshot.failedChoice
      publish({ retrying: true })
      try {
        const current = await getAppPreferences()
        // Reading a host revision does not authorize reasserting a superseded choice.
        if (isLatestTelemetryConsentChoice(choice))
          await saveChoice(choice, current.telemetryConsentRevision)
      } catch (error) {
        report('[telemetry] Consent retry could not read settings', error)
      } finally {
        publish({ retrying: false })
      }
    },
  }
}
