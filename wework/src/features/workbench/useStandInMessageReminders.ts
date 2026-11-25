import { useMemo, useState, useSyncExternalStore } from 'react'
import { dequal } from 'dequal'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'
import type { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import type { WorkbenchServices } from './workbenchServices'
import type { WeworkNotificationPreferences } from '@/api/notifications'
import {
  createStandInMessageReminderSource,
  type StandInMessageReminderIdentity,
} from './standInMessageReminderSource'

export function isStandInIdentity(item: RuntimeTaskReminderItem): boolean {
  const origin = item.task.runtimeHandle?.origin
  return Boolean(
    origin && typeof origin === 'object' && 'type' in origin && origin.type === 'stand_in_identity'
  )
}

/** Observe canonical messages, not task completion; native subagents stay internal. */
export function useStandInMessageReminders(
  items: RuntimeTaskReminderItem[],
  store: RuntimeTaskLifecycleStore,
  preferences: WeworkNotificationPreferences,
  runtimeApi?: WorkbenchServices['runtimeWorkApi']
) {
  const receipts = store.messageReceipts
  const projected = useMemo<StandInMessageReminderIdentity[]>(
    () =>
      items.filter(isStandInIdentity).map(item => {
        const origin = item.task.runtimeHandle?.origin as { standInId?: unknown } | undefined
        return {
          key: item.key,
          address: item.address,
          title: item.task.title,
          standInId: typeof origin?.standInId === 'string' ? origin.standInId : undefined,
          unread: item.lifecycle?.unread ?? false,
        }
      }),
    [items]
  )
  // Preserve the committed identity list through unrelated updates and suspended renders.
  const [identities, setIdentities] = useState(projected)
  if (!dequal(identities, projected)) setIdentities(projected)
  const inApp = Boolean(preferences.stand_in.in_app)
  const system = Boolean(preferences.stand_in.system)
  const source = useMemo(
    () => createStandInMessageReminderSource(identities, receipts, inApp, system, runtimeApi),
    [identities, receipts, inApp, system, runtimeApi]
  )
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}
