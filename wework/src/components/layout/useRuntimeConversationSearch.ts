import { useState, useSyncExternalStore } from 'react'
import {
  createRuntimeConversationSearchSource,
  type RuntimeConversationSearchOptions,
} from './runtimeConversationSearchSource'
export function useRuntimeConversationSearch(options: RuntimeConversationSearchOptions) {
  const [source] = useState(() => createRuntimeConversationSearchSource(options))
  const page = useSyncExternalStore(
    listener => source.subscribe(options, listener),
    source.getSnapshot,
    source.getSnapshot
  )
  return { ...source.commands, page }
}
