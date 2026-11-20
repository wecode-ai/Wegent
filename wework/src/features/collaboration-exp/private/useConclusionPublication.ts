import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  createConclusionPublicationSource,
  type ConclusionPublicationInput,
} from './conclusionPublicationSource'
export type { ConclusionPublicationError } from './conclusionPublicationSource'

export function useConclusionPublication(input: ConclusionPublicationInput) {
  const key = JSON.stringify([input.accountKey, input.scopeKey])
  const [source] = useState(() => createConclusionPublicationSource(key))
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(input, listener),
    [source, input]
  )
  const operation = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return {
    publish: source.publish,
    getOperation: source.getSnapshot,
    publishing: operation.scopeKey === key && operation.publishing,
    error: operation.scopeKey === key ? operation.error : null,
  }
}
