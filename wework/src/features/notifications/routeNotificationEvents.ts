import type { TFunction } from 'i18next'
import type { ProjectTaskAssignedPayload } from '@/stream/chatStream'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { parseWeworkScheme, weworkIssueScheme } from './scheme'
import { ISSUE_ASSIGNMENTS_CHANGED } from '@/features/todo/issueAssignmentEvents'

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
  const deliveredShares = new Set<string>()
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
        onIssueAssignmentsChanged: userId => {
          if (ownsStream() && userId === input?.currentUserId)
            window.dispatchEvent(new Event(ISSUE_ASSIGNMENTS_CHANGED))
        },
        onRuntimeTransportReplaced: () => {
          if (ownsStream()) window.dispatchEvent(new Event(ISSUE_ASSIGNMENTS_CHANGED))
        },
        onWeworkNotification: () => {
          if (ownsStream()) window.dispatchEvent(new Event('wework-notifications-changed'))
        },
        onIssueShared: ({ id, userId, title, body, url }) => {
          if (
            !ownsStream() ||
            userId !== input?.currentUserId ||
            getDesktopWindowLabel() !== 'main' ||
            deliveredShares.has(id) ||
            !parseWeworkScheme(url)
          )
            return
          deliveredShares.add(id)
          void sendSystemNotification({ title, body, url })
        },
        onProjectTaskAssigned: payload => {
          if (!ownsStream()) return
          if (payload.projectStore !== 'local')
            window.dispatchEvent(new Event(ISSUE_ASSIGNMENTS_CHANGED))
          notifyAssignment(payload)
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
