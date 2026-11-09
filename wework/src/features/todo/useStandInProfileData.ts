import { useEffect, useReducer, useState } from 'react'
import type { AutomationApi } from '@/features/workbench/workbenchServices'
import type { Automation } from '@/types/automation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { WORKBENCH_AUTOMATIONS_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'

export function useStandInProfileSchedules(
  api: AutomationApi | undefined,
  userId: number,
  roleId: string,
  deviceId?: string
) {
  const [revision, retry] = useReducer(value => value + 1, 0)
  const [result, setResult] = useState<{
    scope: string
    items: Automation[]
    error?: string
  }>()
  const scope = JSON.stringify([userId, roleId, deviceId])
  useEffect(() => {
    if (!api) return
    let current = true
    void api.listAutomations().then(
      response => {
        if (!current) return
        const items = response.items.filter(item => {
          const request = item.taskRequest
          return (
            Boolean(request?.standInCalendar) &&
            request?.standInOwner?.userId === userId &&
            request.standInOwner.roleId === roleId &&
            (!request.deviceId || request.deviceId === deviceId)
          )
        })
        setResult({ scope, items })
      },
      cause => {
        if (current)
          setResult(previous => ({
            scope,
            items: previous?.scope === scope ? previous.items : [],
            error: getStandInErrorMessage(cause),
          }))
      }
    )
    return () => {
      current = false
    }
  }, [api, scope, userId, roleId, deviceId, revision])
  useEffect(() => {
    const timer = window.setInterval(retry, 30_000)
    window.addEventListener(WORKBENCH_AUTOMATIONS_CHANGED_EVENT, retry)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(WORKBENCH_AUTOMATIONS_CHANGED_EVENT, retry)
    }
  }, [])
  return {
    items: result?.scope === scope ? result.items : [],
    error: result?.scope === scope ? result.error : undefined,
    loading: Boolean(api && result?.scope !== scope),
    retry,
  }
}
