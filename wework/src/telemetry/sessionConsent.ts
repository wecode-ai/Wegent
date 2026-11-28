import { useCallback, useSyncExternalStore } from 'react'
import type { AppPreferencesState } from '@/features/app-preferences/appPreferencesContext'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'

import { detailedTelemetryPreference } from './config'

let choice: boolean | undefined
let latestChoice: boolean | undefined
let persistedChoice: boolean | undefined
let asked = false
let pending = 0
let generation = 0
const listeners = new Set<() => void>()

export function isLatestTelemetryConsentChoice(value: boolean): boolean {
  return latestChoice === value
}

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
  for (const listener of listeners) listener()
}

export function subscribeSessionTelemetryConsent(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function acknowledgeSavedRefusal(preferences: AppPreferencesState | null): void {
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
}

export function useSessionTelemetryConsent(): boolean | undefined {
  const preferences = useAppPreferencesState()
  const observe = useCallback(
    (listener: () => void) => {
      const stop = subscribeSessionTelemetryConsent(() => {
        acknowledgeSavedRefusal(preferences)
        listener()
      })
      acknowledgeSavedRefusal(preferences)
      return stop
    },
    [preferences]
  )
  return useSyncExternalStore(observe, () => choice)
}

export function useSessionTelemetryConsentAsked(): boolean {
  return useSyncExternalStore(subscribeSessionTelemetryConsent, () => asked)
}

export function saveTelemetryConsent(value: boolean, expectedRevision: number, details?: boolean) {
  setSessionTelemetryConsent(value)
  const currentGeneration = generation
  pending += 1
  return persistChoice(value, currentGeneration, expectedRevision, details).finally(() => {
    if (currentGeneration !== generation) return
    pending -= 1
    if (pending === 0 && persistedChoice === true && latestChoice === true) choice = undefined
    publish()
  })
}

async function persistChoice(
  value: boolean,
  currentGeneration: number,
  expectedRevision: number,
  details?: boolean
): ReturnType<typeof updateAppPreferences> {
  const preferences = await updateAppPreferences(
    {
      telemetryConsentAsked: true,
      telemetryEnabled: value,
      ...(value && details !== undefined && detailedTelemetryPreference(details)),
    },
    expectedRevision
  )
  if (currentGeneration !== generation) return preferences
  // An older request can finish after a later explicit choice from settings.
  if (latestChoice !== undefined && latestChoice !== value)
    return persistChoice(latestChoice, currentGeneration, preferences.telemetryConsentRevision)
  persistedChoice = value
  return preferences
}

export function getSessionTelemetryConsent() {
  return choice
}
