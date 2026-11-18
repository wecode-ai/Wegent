import { buildTrayMenuTaskGroups } from '@/desktop/trayMenuState'
import {
  createRuntimeTaskRouteCoordinator,
  type RouteTrayInput,
} from './runtimeTaskRouteCoordinator'
import { EMPTY_RUNTIME_TASK_REMINDERS, type RuntimeTaskReminderState } from './runtimeTaskReminders'
import { findRuntimeTask } from './workbenchRuntimeHelpers'
import type { WorkbenchSessionState } from './workbenchSessionState'
import type { WorkbenchContextValue } from './workbenchContextTypes'

/** Route recovery observes the canonical reducer and lifecycle facts, never a page render. */
export function createWorkbenchRouteNavigation(
  state: WorkbenchSessionState,
  openRuntimeTask: WorkbenchContextValue['openRuntimeTask']
) {
  let enabled = false
  let releaseLifecycle: (() => void) | undefined
  let reminders = EMPTY_RUNTIME_TASK_REMINDERS
  let tray: RouteTrayInput | undefined
  let traySources: readonly unknown[] | undefined
  const coordinator = createRuntimeTaskRouteCoordinator(() => {
    const current = state.getSnapshot().state
    if (!enabled)
      return { enabled: false, state: current, resolveTask: () => null, openRuntimeTask }
    const lifecycle = state.lifecycleStore.getSnapshot()
    const sources = [current.runtimeWork, lifecycle, reminders]
    if (!traySources || sources.some((value, index) => value !== traySources![index])) {
      traySources = sources
      const { trayUnreadEnabled, trayRunningEnabled } = reminders.preferences
      const english = (navigator.language || '').toLowerCase().startsWith('en')
      tray = {
        groups: buildTrayMenuTaskGroups(current.runtimeWork, {
          reminders,
          lifecycle,
          showUnread: trayUnreadEnabled,
          showRunning: trayRunningEnabled,
        }),
        tooltip:
          trayUnreadEnabled && reminders.unreadCount > 0
            ? english
              ? `${reminders.unreadCount} unread completed`
              : `${reminders.unreadCount} 个未读完成任务`
            : null,
      }
    }
    return {
      enabled,
      state: current,
      resolveTask: address =>
        findRuntimeTask(current.runtimeWork, address) ??
        state.lifecycleStore.selectTask(lifecycle, address)?.task ??
        null,
      isTaskAdmitted: address =>
        state.lifecycleStore.selectTask(lifecycle, address)?.derived.isRunning ?? false,
      openRuntimeTask,
      tray,
    }
  })
  return {
    update(active: boolean, taskReminders?: RuntimeTaskReminderState) {
      enabled = active
      reminders = taskReminders ?? EMPTY_RUNTIME_TASK_REMINDERS
      if (active && !releaseLifecycle)
        releaseLifecycle = state.lifecycleStore.subscribe(() => coordinator.update())
      if (!active) {
        releaseLifecycle?.()
        releaseLifecycle = undefined
      }
      coordinator.update()
    },
    stop() {
      enabled = false
      releaseLifecycle?.()
      releaseLifecycle = undefined
      coordinator.stop()
    },
  }
}
