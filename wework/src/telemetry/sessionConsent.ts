import { useSyncExternalStore } from 'react'
import { updateAppPreferences } from '@/desktop/appPreferences'

let choice: boolean | undefined
const listeners = new Set<() => void>()

export function setSessionTelemetryConsent(value: boolean | undefined): void {
  choice = value
  for (const listener of listeners) listener()
}

export function useSessionTelemetryConsent(): boolean | undefined {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => choice
  )
}

export function saveTelemetryConsent(value: boolean) {
  setSessionTelemetryConsent(value)
  return persistChoice(value)
}

async function persistChoice(value: boolean): ReturnType<typeof updateAppPreferences> {
  const preferences = await updateAppPreferences({
    telemetryConsentAsked: true,
    telemetryEnabled: value,
  })
  // An older request can finish after a later explicit choice from settings.
  if (choice !== undefined && choice !== value) return persistChoice(choice)
  return preferences
}
