import { useEffect, useSyncExternalStore } from 'react'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'

let choice: boolean | undefined
let latestChoice: boolean | undefined
let persistedChoice: boolean | undefined
let asked = false
let pending = 0
let generation = 0
let revision = 0
const listeners = new Set<() => void>()

export function setSessionTelemetryConsent(value: boolean | undefined): void {
  if (value === undefined) {
    generation += 1
    pending = 0
  }
  choice = value
  latestChoice = value
  persistedChoice = undefined
  asked = value !== undefined
  publish()
}

function publish(): void {
  revision += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSessionTelemetryConsent(): boolean | undefined {
  const currentRevision = useSyncExternalStore(subscribe, () => revision)
  const preferences = useAppPreferencesState()
  useEffect(() => {
    if (
      choice === false &&
      pending === 0 &&
      persistedChoice === false &&
      preferences?.loaded &&
      preferences.preferences.telemetryConsentAsked &&
      !preferences.preferences.telemetryEnabled
    ) {
      choice = undefined
      publish()
    }
  }, [currentRevision, preferences])
  return choice
}

export function useSessionTelemetryConsentAsked(): boolean {
  useSyncExternalStore(subscribe, () => revision)
  return asked
}

export function saveTelemetryConsent(value: boolean) {
  setSessionTelemetryConsent(value)
  const currentGeneration = generation
  pending += 1
  return persistChoice(value, currentGeneration).finally(() => {
    if (currentGeneration !== generation) return
    pending -= 1
    if (pending === 0 && persistedChoice === true && latestChoice === true) choice = undefined
    publish()
  })
}

async function persistChoice(
  value: boolean,
  currentGeneration: number
): ReturnType<typeof updateAppPreferences> {
  const preferences = await updateAppPreferences({
    telemetryConsentAsked: true,
    telemetryEnabled: value,
  })
  if (currentGeneration !== generation) return preferences
  // An older request can finish after a later explicit choice from settings.
  if (latestChoice !== undefined && latestChoice !== value)
    return persistChoice(latestChoice, currentGeneration)
  persistedChoice = value
  return preferences
}
