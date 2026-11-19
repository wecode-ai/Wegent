import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import type { ExperienceSource } from './useExperienceSources'
import { createExperienceTaskSubscriptions } from './experienceTaskSubscriptions'

export function useExperienceTaskSubscriptions(
  sources: ExperienceSource[],
  active: boolean,
  refresh: () => void
) {
  const source = useMemo(() => createExperienceTaskSubscriptions(sources), [sources])
  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, refresh),
    [source, refresh]
  )
  const error = useSyncExternalStore(
    active ? subscribe : subscribeIdleResource,
    source.getSnapshot,
    source.getSnapshot
  )
  return { retry: source.retry, error: active && error }
}
