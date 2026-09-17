import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'

/** One addressed stop at a time; late responses cannot change a newly opened Issue. */
export function useIssueExecutionCancellation(
  scope: string,
  cancel: (address: RuntimeTaskAddress) => Promise<unknown>,
  failureLabel: string
) {
  const request = useRef<object | null>(null)
  const [state, setState] = useState<{
    scope: string
    messageId: string | null
    error: string | null
  }>({ scope, messageId: null, error: null })
  useEffect(
    () => () => {
      request.current = null
    },
    [scope]
  )
  const stop = useCallback(
    async (messageId: string, address: RuntimeTaskAddress) => {
      if (request.current) return
      const pending = {}
      request.current = pending
      setState({ scope, messageId, error: null })
      try {
        await cancel(address)
        if (request.current === pending) setState({ scope, messageId: null, error: null })
      } catch (cause) {
        if (request.current === pending)
          setState({
            scope,
            messageId: null,
            error: cause instanceof Error ? cause.message : failureLabel,
          })
      } finally {
        if (request.current === pending) request.current = null
      }
    },
    [scope, cancel, failureLabel]
  )
  return {
    stop,
    stoppingMessageId: state.scope === scope ? state.messageId : null,
    error: state.scope === scope ? state.error : null,
  }
}
