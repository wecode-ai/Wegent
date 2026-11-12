import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useCallback, useEffect, useState } from 'react'
import type { StandInExecutorApi, StandInProcessingStatus } from '@/api/standIn'

export function useStandInProcessingStatus(
  api: StandInExecutorApi | undefined,
  userId: number,
  deviceId: string,
  enabled: boolean
) {
  const scope = `${userId}:${deviceId}`
  const [state, setState] = useState<{
    scope: string
    api: StandInExecutorApi | undefined
    status: StandInProcessingStatus | null
    error: string | null
  }>({ scope, api, status: null, error: null })
  const setStatus = useCallback(
    (status: StandInProcessingStatus) => {
      setState(previous => ({
        scope,
        api,
        status,
        error: previous.scope === scope && previous.api === api ? previous.error : null,
      }))
    },
    [scope, api]
  )
  const setError = useCallback(
    (error: string | null) => {
      setState(previous => ({
        scope,
        api,
        status: previous.scope === scope && previous.api === api ? previous.status : null,
        error,
      }))
    },
    [scope, api]
  )
  useEffect(() => {
    if (!api || !enabled) return
    let active = true
    const load = () => {
      void api
        .processingStatus(userId, deviceId)
        .then(result => {
          if (active) setState({ scope, api, status: result, error: null })
        })
        .catch(cause => {
          if (active) setError(getStandInErrorMessage(cause))
        })
    }
    load()
    const timer = setInterval(load, 15000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api, enabled, userId, deviceId, scope, setError])
  const current = enabled && state.scope === scope && state.api === api
  return {
    status: current ? state.status : null,
    error: current ? state.error : null,
    setStatus,
    setError,
  }
}
