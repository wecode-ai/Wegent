import { useMemo, useSyncExternalStore } from 'react'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import type { WorkbenchServices } from './workbenchServices'
import type { WeworkNotificationPreferences } from '@/api/notifications'
import { isStandInIdentityTask } from '@/lib/runtime-task-visibility'
import { createStandInMessageReminderSource } from './standInMessageReminderSource'

export function isStandInIdentity(item: RuntimeTaskReminderItem): boolean {
  return isStandInIdentityTask(item.task)
}

/** Observe canonical messages, not task completion; native subagents stay internal. */
export function useStandInMessageReminders(
  items: RuntimeTaskReminderItem[],
  store: RuntimeTaskLifecycleStore,
  preferences: WeworkNotificationPreferences,
  runtimeApi?: WorkbenchServices['runtimeWorkApi']
) {
  const receipts = store.messageReceipts
  const identities = useMemo(() => items.filter(isStandInIdentity), [items])
  const inApp = Boolean(preferences.stand_in.in_app)
  const system = Boolean(preferences.stand_in.system)
  const source = useMemo(
    () => createStandInMessageReminderSource(identities, receipts, inApp, system, runtimeApi),
    [identities, receipts, inApp, system, runtimeApi]
  )
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}
