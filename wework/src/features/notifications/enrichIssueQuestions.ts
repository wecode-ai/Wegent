import type { IssueHumanRequest } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { issueHumanInteraction, issueQuestionIdentity } from './issueHumanInteractions'
import { canQuickReply, type RuntimeInteraction } from './runtimeInteractions'
import { logInteractionLoadFailure } from './interactionDiagnostics'

/** One poll shares Issue lookups; optional enrichment never invalidates a loaded transcript. */
export function createIssueQuestionEnricher(
  services: WorkbenchServices | undefined,
  userId: number | undefined,
  inbox: () => readonly RuntimeInteraction[]
) {
  const reads = new Map<string, Promise<IssueHumanRequest[] | null>>()
  return async (questions: RuntimeInteraction[]): Promise<RuntimeInteraction[]> => {
    const enriched = await Promise.all(
      questions.map(async question => {
        const project = question.project
        if (!project || !canQuickReply(question.payload)) return question
        const api =
          project.store === 'local'
            ? services?.localIssueHumanRequestsApi
            : services?.issueHumanRequestsApi
        if (!api) return question
        const key = JSON.stringify([project.store, project.projectId, project.issueId])
        if (!reads.has(key))
          reads.set(
            key,
            api
              .list(project.projectId, project.issueId)
              .then(result => result.items)
              .catch(error => {
                logInteractionLoadFailure('transcript', error, question.task.address)
                return null
              })
          )
        const listed = await reads.get(key)!
        if (!listed) {
          const identity = issueQuestionIdentity(question)
          if (identity && inbox().some(item => issueQuestionIdentity(item) === identity))
            return null
          // A failed authority lookup cannot grant a native question shared-reply privileges.
          return { ...question, replyUnavailable: true }
        }
        const shared = listed.find(
          request =>
            request.item_id === (question.payload.itemId ?? question.payload.item_id) &&
            request.runtime_task_id === question.task.address.taskId
        )
        if (!shared) return question
        const viewers =
          project.store === 'local'
            ? (services?.localParticipationIdentity?.viewerUserIds ?? [0])
            : [userId]
        const addressed = viewers.some(
          user =>
            user != null &&
            (shared.recipient_user_id === user ||
              (shared.recipient_user_id === null && shared.responsible_user_id === user))
        )
        if (!addressed || !['pending', 'answering'].includes(shared.status)) return null
        return {
          ...question,
          id: issueHumanInteraction(shared, project.store).id,
          sharedRequest: shared,
          answered: false,
        }
      })
    )
    return enriched.filter((question): question is RuntimeInteraction => question !== null)
  }
}
