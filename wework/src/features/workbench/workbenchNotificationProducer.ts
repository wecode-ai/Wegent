import type { NotificationTaskRegistry } from '@/features/notifications/notificationTaskRegistry'
import type { TaskSource } from '@/features/notifications/NotificationTaskSourceContext'
import type { RuntimeTaskReminderState } from './runtimeTaskReminders'
import type { WorkbenchSessionState } from './workbenchSessionState'
import type { WorkbenchServices } from './workbenchServices'
import type { WorkbenchSessionOperations } from './workbenchSessionOperations'

/** Publish committed tab capabilities with a lease that cannot revoke a replacement owner. */
export function createWorkbenchNotificationProducer(
  state: WorkbenchSessionState,
  accountKey: string,
  tabId: string | undefined,
  refresh: WorkbenchSessionOperations['stableRefreshWorkLists']
) {
  const owner = { id: tabId ?? '', accountKey }
  let registry: NotificationTaskRegistry | null = null
  let lease: ReturnType<NotificationTaskRegistry['claim']> | undefined
  let reminders: RuntimeTaskReminderState | null = null
  let source: TaskSource | null = null
  function release() {
    lease?.release()
    lease = undefined
    registry = null
    reminders = null
    source = null
  }
  return {
    update(
      nextRegistry: NotificationTaskRegistry | null,
      nextReminders: RuntimeTaskReminderState | null,
      services: WorkbenchServices,
      active: boolean
    ) {
      if (!tabId || !nextRegistry || !nextReminders) {
        release()
        return
      }
      if (registry !== nextRegistry) {
        release()
        registry = nextRegistry
      }
      const current = state.getSnapshot().state
      if (
        !source ||
        reminders !== nextReminders ||
        source.services !== services ||
        source.devices !== current.devices ||
        source.currentAddress !== current.currentRuntimeTask ||
        source.userId !== current.user?.id
      ) {
        reminders = nextReminders
        source = {
          ...nextReminders,
          services,
          devices: current.devices,
          currentAddress: current.currentRuntimeTask,
          userId: current.user?.id,
          refresh,
        }
      }
      if (!lease) lease = nextRegistry.claim(owner, source, active)
      else lease.update(source, active)
    },
    setActive(active: boolean) {
      if (source) lease?.update(source, active)
    },
    release,
  }
}
