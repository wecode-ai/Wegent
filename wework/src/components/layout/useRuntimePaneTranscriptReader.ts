import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { RuntimeTranscriptLoader } from '@/types/workbench'
import {
  abortableRuntimeRead,
  cancelledRuntimeRead,
} from '@/features/workbench/runtimeConversationReadCancellation'

interface RuntimePaneTranscriptReader {
  read: RuntimeTranscriptLoader
  isCurrent: () => boolean
}

/** Transcript subscriptions and UI commits belong to one mounted pane generation. */
export function useRuntimePaneTranscriptReader(
  read: RuntimeTranscriptLoader,
  targetKey: string | null,
  reloadRevision: number
): RuntimePaneTranscriptReader {
  const reader = useRef(read)
  useLayoutEffect(() => {
    reader.current = read
  }, [read])
  const scope = useMemo(
    () => ({ key: targetKey, revision: reloadRevision }),
    [targetKey, reloadRevision]
  )
  const active = useRef<{ scope: typeof scope; controller: AbortController } | null>(null)
  useLayoutEffect(() => {
    const current = { scope, controller: new AbortController() }
    active.current = current
    return () => {
      current.controller.abort()
      if (active.current === current) active.current = null
    }
  }, [scope])

  const isCurrent = useCallback(
    () => active.current?.scope === scope && !active.current.controller.signal.aborted,
    [scope]
  )
  const readTranscript = useCallback<RuntimeTranscriptLoader>(
    (address, options = {}) => {
      // The owning pane may also read other conversations explicitly referenced by its composer.
      const current = active.current
      if (!current || current.scope !== scope) {
        return Promise.reject(cancelledRuntimeRead())
      }
      const signal = options.signal
        ? AbortSignal.any([current.controller.signal, options.signal])
        : current.controller.signal
      if (signal.aborted) return Promise.reject(cancelledRuntimeRead())
      return abortableRuntimeRead(reader.current(address, { ...options, signal }), signal)
    },
    [scope]
  )
  return useMemo(() => ({ read: readTranscript, isCurrent }), [readTranscript, isCurrent])
}
