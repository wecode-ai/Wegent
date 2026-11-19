import { subscribePersonalStandIn } from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createAsyncResource } from '@wegent/chat-core/async-resource'

/** The project badge follows accepted settings for one personal owner and Executor. */
export function createStandInPopoverSettingsResource({
  api,
  identify,
  userId,
  deviceId,
}: {
  api: NonNullable<WorkbenchServices['standInApi']>
  identify: WorkbenchServices['getLocalRuntimeSidebarIdentity']
  userId: number
  deviceId: string | undefined
}) {
  let targetDeviceId = deviceId
  const resource = createAsyncResource(
    JSON.stringify(['stand-in-project-badge', userId, deviceId]),
    async signal => {
      const identity = await identify?.()
      signal.throwIfAborted()
      if (!identity) return null
      targetDeviceId = deviceId || identity.deviceId
      return api.personalGet(userId, targetDeviceId)
    }
  )
  return {
    getSnapshot: resource.getSnapshot,
    subscribe(listener: () => void) {
      const stopEvents = subscribePersonalStandIn(value => {
        if (value.userId === userId && value.executionDeviceId === targetDeviceId) {
          // An accepted save supersedes an older initial read, including one still pending.
          resource.update(() => value)
        }
      })
      const stopQuery = resource.subscribe(listener)
      return () => {
        stopEvents()
        stopQuery()
      }
    },
  }
}
