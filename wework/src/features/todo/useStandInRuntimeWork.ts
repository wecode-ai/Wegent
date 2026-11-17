import { useCallback, useEffect, useState } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeWorkListResponse } from '@/types/api'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'

type RuntimeWorkApi = NonNullable<WorkbenchServices['runtimeWorkApi']>

/** Keep environment reads and recovery independent of editable personal settings. */
export function useStandInRuntimeWork(
  api: RuntimeWorkApi | undefined,
  deviceId: string | undefined,
  enabled = true
) {
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{
    api: RuntimeWorkApi
    deviceId: string
    work: RuntimeWorkListResponse | null
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!enabled || !api || !deviceId) return
    let active = true
    void api.listRuntimeWork({ deviceId }).then(
      work => {
        if (active) setResult({ api, deviceId, work, error: null })
      },
      cause => {
        if (!active) return
        reportStandInError('load_environment', cause, deviceId)
        setResult(previous => ({
          api,
          deviceId,
          work: previous?.api === api && previous.deviceId === deviceId ? previous.work : null,
          error: getStandInErrorMessage(cause, 'load_environment_failed'),
        }))
      }
    )
    return () => {
      active = false
    }
  }, [api, deviceId, enabled, revision])
  const current = result?.api === api && result?.deviceId === deviceId ? result : null
  const retryRuntimeWork = useCallback(() => setRevision(value => value + 1), [])
  return {
    runtimeWork: current?.work ?? null,
    runtimeError: current?.error ?? null,
    retryRuntimeWork,
  }
}
