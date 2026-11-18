import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { isLocalHarnessAvailable, listLocalHarnesses } from '@/lib/local-terminal'
import type { LocalHarnessPreference } from '@/lib/local-harness'

export function useLocalHarnessCatalog(enabled: boolean, preferences: LocalHarnessPreference[]) {
  const executableOverrides = useMemo(
    () =>
      Object.fromEntries(preferences.map(preference => [preference.id, preference.executablePath])),
    [preferences]
  )
  const enabledLocalHarnesses = useMemo(
    () => (enabled ? preferences.filter(preference => preference.enabled) : []),
    [enabled, preferences]
  )
  const available = enabled && isLocalHarnessAvailable()
  const resource = useMemo(
    () =>
      createAsyncResource(
        JSON.stringify(executableOverrides),
        () => listLocalHarnesses(executableOverrides),
        {
          refreshOnSubscribe: true,
          failure: error => console.error('Failed to detect local harnesses:', error),
        }
      ),
    [executableOverrides]
  )
  const snapshot = useSyncExternalStore(
    available ? resource.subscribe : subscribeIdleResource,
    available ? resource.getSnapshot : getIdleResourceSnapshot,
    available ? resource.getSnapshot : getIdleResourceSnapshot
  )
  return {
    enabledLocalHarnesses,
    localHarnesses: snapshot.status === 'error' ? [] : (snapshot.data ?? []),
    localHarnessesLoading: available && !snapshot.settled,
    localHarnessDetectionFailed: snapshot.status === 'error',
  }
}
