import { useCallback, useRef, useState } from 'react'

export interface RuntimeFailureAction {
  id: string
  label: string
  error: string
  phoneOwned: boolean
  retrying: boolean
  retry: () => Promise<unknown>
}

/** A failed read owns its retry; unrelated operations never share a queue. */
export function useRuntimeFailures() {
  const [failures, setFailures] = useState<RuntimeFailureAction[]>([])
  const entries = useRef(failures)
  const pending = useRef(new Map<string, symbol>())
  const publish = useCallback((next: RuntimeFailureAction[]) => {
    entries.current = next
    setFailures(next)
  }, [])
  const reportFailure = useCallback(
    (failure: Omit<RuntimeFailureAction, 'retrying'>) => {
      const next = { ...failure, retrying: pending.current.has(failure.id) }
      const index = entries.current.findIndex(item => item.id === failure.id)
      publish(
        index < 0
          ? [...entries.current, next]
          : entries.current.map((item, i) => (i === index ? next : item))
      )
    },
    [publish]
  )
  const clearFailure = useCallback(
    (id: string) => {
      pending.current.delete(id)
      if (entries.current.some(item => item.id === id))
        publish(entries.current.filter(item => item.id !== id))
    },
    [publish]
  )
  const clearRemoteFailures = useCallback(() => {
    for (const item of entries.current) if (!item.phoneOwned) pending.current.delete(item.id)
    publish(entries.current.filter(item => item.phoneOwned))
  }, [publish])
  const retryFailure = useCallback(
    async (failure: RuntimeFailureAction) => {
      // Validate the menu's entry and reserve synchronously, before React renders.
      if (!entries.current.includes(failure) || pending.current.has(failure.id)) return
      const attempt = Symbol(failure.id)
      pending.current.set(failure.id, attempt)
      publish(
        entries.current.map(item => (item.id === failure.id ? { ...item, retrying: true } : item))
      )
      try {
        await failure.retry()
        // Only the operation owner can confirm recovery and clear the failure.
      } catch (cause) {
        if (pending.current.get(failure.id) !== attempt) return
        publish(
          entries.current.map(item =>
            item.id === failure.id && item.retry === failure.retry
              ? {
                  ...item,
                  error: cause instanceof Error ? cause.message : String(cause),
                }
              : item
          )
        )
      } finally {
        if (pending.current.get(failure.id) === attempt) {
          pending.current.delete(failure.id)
          publish(
            entries.current.map(item =>
              item.id === failure.id ? { ...item, retrying: false } : item
            )
          )
        }
      }
    },
    [publish]
  )
  return { failures, reportFailure, clearFailure, clearRemoteFailures, retryFailure }
}
