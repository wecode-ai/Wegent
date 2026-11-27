import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { isStandInMemoryReviewTask } from '@/lib/runtime-task-visibility'
import type { TaskSource } from './NotificationTaskSourceContext'
import type { useIssueHumanInteractions } from './useIssueHumanInteractions'
import type { InteractionHistory, RuntimeInteractionsValue } from './RuntimeInteractionsContext'
import type { RuntimeInteraction } from './runtimeInteractions'
import {
  isResolvedIssueQuestion,
  issueQuestionIdentity,
  issueQuestionHandoff,
  hasRecordedIssueResolution,
} from './issueHumanInteractions'

interface PendingProjection {
  source: TaskSource | null
  inventory: RuntimeTaskReminderItem[]
  loaded: Record<string, RuntimeInteraction[]>
  errors: Record<string, string>
  submitted: ReadonlySet<string>
  history: InteractionHistory[]
  issueInteractions: ReturnType<typeof useIssueHumanInteractions>
  acceptancePrefix: string
  isDismissed: NonNullable<RuntimeInteractionsValue['isDismissed']>
}

/** Project the authoritative inbox and native requests without broadening their reply authority. */
export function selectPendingRuntimeInteractions({
  source,
  inventory,
  loaded,
  errors,
  submitted,
  history,
  issueInteractions,
  acceptancePrefix,
  isDismissed,
}: PendingProjection): RuntimeInteraction[] {
  if (!issueInteractions.items.length && !Object.keys(loaded).length) return []
  const visible = new Map(
    [...(source?.items ?? []), ...inventory]
      .filter(item => !isStandInMemoryReviewTask(item.task))
      .map(item => [item.key, item])
  )
  const runtime = Object.values(loaded)
    .flat()
    .filter(
      item =>
        !item.answered &&
        !isDismissed(item.id, issueQuestionIdentity(item), issueQuestionHandoff(item)) &&
        !isResolvedIssueQuestion(item, issueInteractions.resolved) &&
        !isResolvedIssueQuestion(item, issueInteractions.transferred) &&
        !hasRecordedIssueResolution(item, history) &&
        !submitted.has(item.id) &&
        localStorage.getItem(acceptancePrefix + item.id) === null &&
        visible.has(item.task.key) &&
        (!item.payload.expiresAtUnixMs || item.payload.expiresAtUnixMs > Date.now())
    )
    .map(item => {
      const task = visible.get(item.task.key)!
      return {
        ...item,
        task:
          errors[`inventory:${task.address.deviceId}`] || errors['inventory:']
            ? { ...task, workspace: { ...task.workspace, available: false } }
            : task,
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
  const shared = new Set(issueInteractions.items.map(item => item.id))
  const sharedQuestions = new Set(
    issueInteractions.items.map(issueQuestionIdentity).filter(Boolean)
  )
  const sharedItems = issueInteractions.items.map(item => {
    const identity = issueQuestionIdentity(item)
    const native =
      identity && runtime.find(candidate => issueQuestionIdentity(candidate) === identity)
    return native ? { ...item, source: native.source, task: native.task } : item
  })
  return [
    ...runtime.filter(
      item => !shared.has(item.id) && !sharedQuestions.has(issueQuestionIdentity(item))
    ),
    ...sharedItems.filter(
      item =>
        !isDismissed(item.id, issueQuestionIdentity(item), issueQuestionHandoff(item)) &&
        (!item.cached ||
          (!isResolvedIssueQuestion(item, issueInteractions.resolved) &&
            !hasRecordedIssueResolution(item, history)))
    ),
  ].sort((a, b) => b.createdAt - a.createdAt)
}
