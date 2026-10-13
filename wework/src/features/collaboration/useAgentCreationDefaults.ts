import { useContext, useMemo } from 'react'

import { getKnownLocalExecutorDeviceId } from '@/desktop/localExecutor'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { getWorkbenchDeviceIds, workbenchDeviceMatchesId } from '@/lib/workbench-device'

/** Creation snapshots become fixed choices, never dynamic execution defaults. */
export function useAgentCreationDefaults(enabled: boolean) {
  const workbench = useContext(WorkbenchContext)
  const defaultDeviceId = workbench?.state.user?.preferences?.default_execution_target
  const currentDeviceId = getKnownLocalExecutorDeviceId()
  const devices = workbench?.state.devices
  return useMemo(
    () =>
      enabled
        ? {
            preferredDeviceIds: [defaultDeviceId, currentDeviceId].flatMap(id => {
              if (!id) return []
              const device = devices?.find(device => workbenchDeviceMatchesId(device, id))
              return device ? getWorkbenchDeviceIds(device) : [id]
            }),
          }
        : undefined,
    [enabled, defaultDeviceId, currentDeviceId, devices]
  )
}
