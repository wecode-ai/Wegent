import type { RequestUserInputPayload, RequestUserInputResponse } from '@wegent/chat-core/runtime'
import {
  isAsyncRequestUserInputPayload,
  isPendingRequestUserInputBlock,
  isRequestUserInputBlock,
  hasRequestUserInputResponse,
  requestUserInputPayloadKey,
  resolveAsyncRequestUserInputAnswers,
  requestUserInputApprovalDescription,
} from '@wegent/chat-core/runtime-user-input'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { projectRuntimePaneTranscript } from '@/features/workbench/runtimeTaskLifecycle/projection'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { WorkbenchMessage } from '@/types/workbench'
import { weworkIssueScheme, weworkTaskScheme } from './scheme'
import i18n from '@/i18n'

export interface RuntimeInteraction {
  id: string
  requestKey: string
  task: RuntimeTaskReminderItem
  payload: RequestUserInputPayload
  question: string
  context: string
  createdAt: number
  answered: boolean
  running?: boolean
  cached?: boolean
  originalUrl?: string
  project?: {
    projectId: string
    issueId: string
    rootCommentId?: string
    store: 'local' | 'backend'
  }
}

export function interactionId(task: RuntimeTaskReminderItem, requestKey: string): string {
  return JSON.stringify([task.address.deviceId, task.address.taskId, requestKey])
}

/** Only ordinary single-question business input is eligible for quick replies. */
export function canQuickReply(payload: RequestUserInputPayload): boolean {
  return Boolean(
    !payload.approvalKind &&
    !payload.approval_kind &&
    !payload.mode &&
    !payload.elicitationId &&
    !payload.serverName &&
    (!payload.interactionKind || payload.interactionKind === 'question') &&
    (!payload.interaction_kind || payload.interaction_kind === 'question') &&
    payload.questions?.length === 1 &&
    payload.questions[0].id &&
    !payload.questions[0].id.startsWith('mcp_tool_call_approval_')
  )
}

export function interactionResponse(
  payload: RequestUserInputPayload,
  answers: RequestUserInputResponse['answers']
): RequestUserInputResponse {
  return {
    requestId: payload.requestId ?? payload.request_id,
    itemId: payload.itemId ?? payload.item_id,
    ...(payload.interactionScope ? { interactionScope: payload.interactionScope } : {}),
    answers,
  }
}

export function interactionAllowsNativeReply(payload: RequestUserInputPayload): boolean {
  return canQuickReply(payload) && isAsyncRequestUserInputPayload(payload)
}

export function canReplyToInteraction(item: RuntimeInteraction): boolean {
  if (item.task.workspace.available === false) return false
  if (!canQuickReply(item.payload)) return false
  if (item.project)
    return Boolean(item.project.rootCommentId && isAsyncRequestUserInputPayload(item.payload))
  return !item.task.address.issueExecution && !item.task.address.projectSession
}

export function interactionOriginalScheme(item: RuntimeInteraction): string {
  if (item.cached && item.originalUrl) return item.originalUrl
  if (item.project) {
    const url = weworkIssueScheme(item.project.projectId, item.project.issueId, item.project.store)
    return item.project.rootCommentId
      ? `${url}/comments/${encodeURIComponent(item.project.rootCommentId)}`
      : url
  }
  const issue = item.task.address.issueExecution ?? item.task.address.projectSession
  return issue
    ? weworkIssueScheme(issue.projectId, issue.issueId)
    : weworkTaskScheme(item.task.address)
}

/** Read every history page: an async question may outlive several later turns. */
export async function readRuntimeInteractions(
  task: RuntimeTaskReminderItem,
  api: NonNullable<WorkbenchServices['runtimeWorkApi']>
): Promise<RuntimeInteraction[]> {
  const pages: WorkbenchMessage[][] = []
  const cursors = new Set<string>()
  let beforeCursor: string | undefined
  let origin = task.task.runtimeHandle?.origin
  let running: boolean | undefined
  for (;;) {
    const response = await api.getRuntimeTranscript({
      ...task.address,
      limit: 100,
      beforeCursor,
      includeFullContent: true,
    })
    origin = response.origin ?? origin
    running ??= response.running
    if (response.historyUnavailable || response.parseError) {
      throw new Error(response.parseError || 'Runtime history is unavailable')
    }
    pages.unshift(projectRuntimePaneTranscript(response).messages)
    if (!response.hasMoreBefore) break
    const cursor = response.beforeCursor
    if (!cursor || cursors.has(cursor)) throw new Error('Incomplete runtime interaction history')
    cursors.add(cursor)
    beforeCursor = cursor
  }
  const messages = resolveAsyncRequestUserInputAnswers(pages.flat())
  const requests = new Map<string, RuntimeInteraction>()
  const project =
    origin &&
    typeof origin === 'object' &&
    'type' in origin &&
    origin.type === 'board_comment' &&
    'cloudProjectId' in origin &&
    typeof origin.cloudProjectId === 'string' &&
    'loopItemId' in origin &&
    typeof origin.loopItemId === 'string'
      ? {
          projectId: origin.cloudProjectId,
          issueId: origin.loopItemId,
          rootCommentId:
            'rootCommentId' in origin && typeof origin.rootCommentId === 'string'
              ? origin.rootCommentId
              : undefined,
          store:
            'projectStore' in origin && origin.projectStore === 'local'
              ? ('local' as const)
              : ('backend' as const),
        }
      : undefined
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (!isRequestUserInputBlock(block)) continue
      const original = block.renderPayload
      const payload =
        original.interactionScope || !message.turnId || isAsyncRequestUserInputPayload(original)
          ? original
          : { ...original, interactionScope: message.turnId }
      const answered =
        hasRequestUserInputResponse(payload) || payload.interactionStatus === 'answered'
      if (!answered && !isPendingRequestUserInputBlock(block)) continue
      const key = requestUserInputPayloadKey(payload)
      if (!key) continue
      const question = payload.questions
        ?.map(q => q.question || q.header)
        .filter(Boolean)
        .join('\n')
      const approval =
        payload.interactionKind === 'approval' ||
        payload.interaction_kind === 'approval' ||
        payload.approvalKind ||
        payload.approval_kind
          ? requestUserInputApprovalDescription(payload)
          : undefined
      requests.set(key, {
        id: interactionId(task, key),
        requestKey: key,
        task,
        payload,
        question: approval
          ? i18n.t(`chat:${approval.key}`, {
              detail: approval.detail || i18n.t('chat:request_user_input.approval_no_detail'),
            })
          : question || payload.message || payload.reason || task.task.title,
        context: approval
          ? approval.detail || ''
          : payload.reason || message.content.trim().slice(0, 1200),
        createdAt: new Date(message.createdAt ?? task.task.createdAt ?? 0).getTime() || 0,
        answered,
        running,
        project,
      })
    }
  }
  return [...requests.values()]
}
