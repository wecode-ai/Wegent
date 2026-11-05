import { useMemo } from 'react'
import type { CollaborationHostAdapter, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ConnectionAutomationRule } from '@wegent/collaboration/automation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ConnectionRuleRunnerButton } from './ConnectionRuleRunnerButton'
import { configureConnectionRuleRunner } from './configureConnectionRuleRunner'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'

export function useConnectionAutomationHost(
  services: WorkbenchServices,
  userId: number,
  projectApi: SharedWorkspaceApi | null | undefined
): CollaborationHostAdapter['connectionAutomation'] {
  const connection = useOptionalCloudConnection()
  const authority = connection.apiBaseUrl ?? 'local'
  const actorId = connection.serviceKey?.startsWith('fallback:')
    ? userId
    : (connection.user?.id ?? userId)
  return useMemo(() => {
    const api = services.standInApi?.connectionRules?.(actorId, { authority })
    if (!api || !projectApi) return undefined
    const configure = (rule: ConnectionAutomationRule) =>
      configureConnectionRuleRunner(rule, services, projectApi)
    return {
      api: { ...api, save: async rule => api.save(await configure(rule)) },
      renderRunnerSelection: (rule, onChange) => (
        <ConnectionRuleRunnerButton
          key={`${rule.targetKind}:${rule.targetId}`}
          rule={rule}
          configure={configure}
          onChange={onChange}
        />
      ),
    }
  }, [services, actorId, projectApi, authority])
}
