import type { IssueHumanRequest } from '@wegent/collaboration'
import type { RuntimeInteraction } from './runtimeInteractions'
import { interactionId } from './runtimeInteractions'

/** The durable item identity survives native request IDs and device aliases. */
export function issueQuestionIdentity(item: RuntimeInteraction): string | null {
  const request = item.sharedRequest
  const project = item.project
  const questionId = request?.item_id ?? item.payload.itemId ?? item.payload.item_id
  if (!project || !questionId) return null
  return JSON.stringify([
    project.store,
    String(project.projectId),
    project.issueId,
    request?.runtime_task_id ?? item.task.address.taskId,
    questionId,
  ])
}

/** Shared Issue questions never require access to another member's private runtime. */
export function issueHumanInteraction(
  request: IssueHumanRequest,
  store: 'local' | 'backend'
): RuntimeInteraction {
  const address = { deviceId: request.runtime_device_id, taskId: request.runtime_task_id }
  const task = {
    key: JSON.stringify([store, request.project_id, request.issue_id, request.id]),
    address,
    task: {
      taskId: request.runtime_task_id,
      title: request.issue_title || request.issue_id,
      workspacePath: '',
      runtime: 'codex' as const,
    },
    workspace: {
      deviceId: request.runtime_device_id,
      workspacePath: '',
      available: true,
      tasks: [],
    },
    projectName: request.project_id,
  }
  return {
    id: interactionId(task, `item:${request.item_id}`),
    requestKey: `item:${request.item_id}`,
    source: 'project',
    task,
    sharedRequest: request,
    payload: {
      kind: 'request_user_input',
      delivery: 'async',
      itemId: request.item_id,
      questions: request.questions?.length
        ? request.questions
        : [{ id: request.id, question: request.question, is_other: true, options: [] }],
    },
    question: request.question,
    createdAt: Date.parse(request.created_at),
    answered: false,
    sourceMessageIds: request.source_message_id ? [request.source_message_id] : undefined,
    project: {
      projectId: request.project_id,
      issueId: request.issue_id,
      rootCommentId: request.root_comment_id,
      store,
    },
  }
}
