import type { TFunction } from 'i18next'
import type { ProjectTaskAssignedPayload } from '@/stream/chatStream'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { weworkIssueScheme } from './scheme'

export interface RouteNotificationInput {
  chatStream: WorkbenchServices['chatStream']
  currentUserId?: number
  localUserId?: number
  t: TFunction<'common'>
}
interface StreamBinding {
  stream: WorkbenchServices['chatStream']
  active: boolean
  release?: () => void
}

/** The window/account route session owns stream delivery and assignment replay receipts. */
export function createRouteNotificationEvents() {
  const deliveredAssignments = new Set<string>()
  let observing = false
  let input: RouteNotificationInput | undefined
  let binding: StreamBinding | undefined
  function disconnect() {
    observing = false
    const previous = binding
    binding = undefined
    input = undefined
    if (!previous) return
    // Runtime streams may flush queued events while removing their listener.
    previous.active = false
    previous.release?.()
  }
  function notifyAssignment(payload: ProjectTaskAssignedPayload) {
    const current = input
    if (!current || getDesktopWindowLabel() !== 'main') return
    const localIdentities = [current.localUserId, current.currentUserId]
      .filter(id => id != null)
      .map(String)
    if (
      payload.projectStore === 'local' &&
      !localIdentities.includes(payload.recipientUserId ?? '')
    )
      return
    const recipientId = payload.recipientUserId ?? current.currentUserId
    if (payload.assignmentId) {
      const key = JSON.stringify([
        String(recipientId),
        payload.projectStore,
        payload.projectId,
        payload.assignmentId,
      ])
      if (deliveredAssignments.has(key)) return
      deliveredAssignments.add(key)
    }
    void sendSystemNotification({
      title: current.t('workbench.project_task_assigned_notification_title'),
      body: current.t('workbench.project_task_assigned_notification_body', {
        assigner: payload.assignerName,
        task: payload.itemTitle,
        project: payload.projectName,
      }),
      url: weworkIssueScheme(payload.projectId, payload.itemId, payload.projectStore),
    })
  }
  return {
    observe(next: RouteNotificationInput) {
      if (binding?.stream === next.chatStream && binding.active) {
        observing = true
        input = next
        return
      }
      disconnect()
      observing = true
      input = next
      const current: StreamBinding = { stream: next.chatStream, active: true }
      binding = current
      const ownsStream = () => observing && binding === current && current.active
      const release = current.stream.subscribe({
        onWeworkNotification: () => {
          if (ownsStream()) window.dispatchEvent(new Event('wework-notifications-changed'))
        },
        onProjectTaskAssigned: payload => {
          if (ownsStream()) notifyAssignment(payload)
        },
      })
      if (binding === current && current.active) current.release = release
      else release()
    },
    suspend() {
      observing = false
    },
    disconnect,
  }
}
