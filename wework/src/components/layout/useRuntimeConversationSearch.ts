import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  createRuntimeConversationSearchSource,
  type RuntimeConversationSearchOptions,
} from './runtimeConversationSearchSource'
export function useRuntimeConversationSearch(options: RuntimeConversationSearchOptions) {
  const [source] = useState(() => createRuntimeConversationSearchSource(options))
  const subscribe = useCallback(
    (listener: () => void) => {
      const release = source.subscribe(listener)
      source.updateOptions(options)
      return release
    },
    [source, options]
  )
  const page = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return { ...source.commands, page }
}
