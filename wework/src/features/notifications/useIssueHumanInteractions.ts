import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeInteraction } from './runtimeInteractions'
import { createIssueHumanInteractionSource } from './issueHumanInteractionSource'

export function useIssueHumanInteractions(
  services: WorkbenchServices | undefined,
  cached: RuntimeInteraction[]
) {
  const cloudApi = services?.issueHumanRequestsApi
  const localApi = services?.localIssueHumanRequestsApi
  const [sources, setSources] = useState(() => ({
    cloud: createIssueHumanInteractionSource(cloudApi, 'backend', cached),
    local: createIssueHumanInteractionSource(localApi, 'local', cached),
  }))
  if (sources.cloud.api !== cloudApi || sources.local.api !== localApi)
    setSources({
      cloud:
        sources.cloud.api === cloudApi
          ? sources.cloud
          : createIssueHumanInteractionSource(cloudApi, 'backend', []),
      local:
        sources.local.api === localApi
          ? sources.local
          : createIssueHumanInteractionSource(localApi, 'local', []),
    })
  const cloud = useSyncExternalStore(
    sources.cloud.subscribe,
    sources.cloud.getSnapshot,
    sources.cloud.getSnapshot
  )
  const local = useSyncExternalStore(
    sources.local.subscribe,
    sources.local.getSnapshot,
    sources.local.getSnapshot
  )
  const refresh = useCallback(
    async (onlyStore?: 'local' | 'backend') => {
      await Promise.all([
        ...(onlyStore !== 'local' ? [sources.cloud.refresh()] : []),
        ...(onlyStore !== 'backend' ? [sources.local.refresh()] : []),
      ])
    },
    [sources]
  )
  const discover = useCallback(
    async (localPending?: boolean) => {
      await Promise.all([sources.cloud.discover(), sources.local.discover(localPending)])
    },
    [sources]
  )
  const snapshot = useMemo(() => {
    const errors: Record<string, string> = {}
    if (cloud.error !== undefined) errors['issue:backend'] = cloud.error
    if (local.error !== undefined) errors['issue:local'] = local.error
    return {
      items: [...cloud.items, ...local.items],
      errors,
      resolved: [...cloud.resolved, ...local.resolved],
      transferred: [...cloud.transferred, ...local.transferred],
    }
  }, [cloud, local])
  return { ...snapshot, refresh, discover }
}
