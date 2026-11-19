import { useCallback, useMemo, useRef, useState } from 'react'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'

/** One addressed stop at a time; late responses cannot change a newly opened Issue. */
export function useIssueExecutionCancellation(
  scope: string,
  cancel: (address: RuntimeTaskAddress) => Promise<unknown>,
  failureLabel: string
) {
  const owner = useMemo(() => ({ scope }), [scope])
  const request = useRef<{ owner: typeof owner } | null>(null)
  const [state, setState] = useState({
    owner,
    messageId: null as string | null,
    error: null as string | null,
  })
  if (state.owner !== owner) setState({ owner, messageId: null, error: null })
  const stop = useCallback(
    async (messageId: string, address: RuntimeTaskAddress) => {
      if (request.current?.owner === owner) return
      const pending = { owner }
      request.current = pending
      const publish = (messageId: string | null, error: string | null) => {
        setState(current => (current.owner === owner ? { owner, messageId, error } : current))
      }
      publish(messageId, null)
      try {
        await cancel(address)
        publish(null, null)
      } catch (cause) {
        publish(null, cause instanceof Error ? cause.message : failureLabel)
      } finally {
        if (request.current === pending) request.current = null
      }
    },
    [owner, cancel, failureLabel]
  )
  return {
    stop,
    stoppingMessageId: state.owner === owner ? state.messageId : null,
    error: state.owner === owner ? state.error : null,
  }
}
