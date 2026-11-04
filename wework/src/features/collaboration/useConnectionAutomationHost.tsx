import { useMemo } from 'react'
import type { CollaborationHostAdapter, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ConnectionAutomationRule } from '@wegent/collaboration/automation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ConnectionRuleRunnerButton } from './ConnectionRuleRunnerButton'
import { configureConnectionRuleRunner } from './configureConnectionRuleRunner'

export function useConnectionAutomationHost(
  services: WorkbenchServices,
  userId: number,
  projectApi: SharedWorkspaceApi | null | undefined
): CollaborationHostAdapter['connectionAutomation'] {
  return useMemo(() => {
    const api = services.standInApi?.connectionRules?.(userId)
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
  }, [services, userId, projectApi])
}
