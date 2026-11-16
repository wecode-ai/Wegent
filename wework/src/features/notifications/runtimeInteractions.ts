import type { RequestUserInputPayload, RequestUserInputResponse } from '@wegent/chat-core/runtime'
import {
  isAsyncRequestUserInputPayload,
  isPendingRequestUserInputBlock,
  isRequestUserInputBlock,
  isSettledRequestUserInputBlock,
  requestUserInputPayloadKey,
  resolveAsyncRequestUserInputAnswers,
  requestUserInputApprovalDescription,
} from '@wegent/chat-core/runtime-user-input'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { projectRuntimePaneTranscript } from '@/features/workbench/runtimeTaskLifecycle/projection'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { WorkbenchMessage } from '@/types/workbench'
import { parseWeworkScheme, weworkIssueScheme, weworkTaskScheme } from './scheme'
import i18n from '@/i18n'

export const INTERACTION_SOURCES = ['task', 'project', 'stand_in'] as const
export type InteractionSource = (typeof INTERACTION_SOURCES)[number]
const ISSUE_ORIGIN_TYPES = ['board_comment', 'board_task', 'issue_dispatch', 'project_automation']

export function isInteractionSource(value: unknown): value is InteractionSource {
  return INTERACTION_SOURCES.some(source => source === value)
}

export function interactionSource(
  item: {
    source?: InteractionSource
    originalUrl?: string
    project?: RuntimeInteraction['project']
    task?: RuntimeInteraction['task']
  },
  origin: unknown = item.task?.task.runtimeHandle?.origin
): InteractionSource {
  if (item.source) return item.source
  if (
    origin &&
    typeof origin === 'object' &&
    'initiatedBy' in origin &&
    origin.initiatedBy === 'stand_in'
  )
    return 'stand_in'
  if (
    item.project ||
    (origin &&
      typeof origin === 'object' &&
      'type' in origin &&
      ISSUE_ORIGIN_TYPES.includes(String(origin.type))) ||
    item.task?.address.issueExecution ||
    item.task?.address.projectSession ||
    (item.originalUrl && parseWeworkScheme(item.originalUrl)?.kind === 'board')
  )
    return 'project'
  return 'task'
}

export interface RuntimeInteraction {
  sharedRequest?: import('@wegent/collaboration').IssueHumanRequest
  source?: InteractionSource
  id: string
  requestKey: string
  task: RuntimeTaskReminderItem
  payload: RequestUserInputPayload
  question: string
  createdAt: number
  answered: boolean
  running?: boolean
  cached?: boolean
  replyUnavailable?: boolean
  originalUrl?: string
  sourceMessageIds?: string[]
  project?: {
    projectId: string
    issueId: string
    rootCommentId?: string
    store: 'local' | 'backend'
  }
}

export function interactionId(
  task: Pick<RuntimeTaskReminderItem, 'address'>,
  requestKey: string
): string {
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
  if (item.replyUnavailable) return false
  if (item.sharedRequest)
    return (
      !item.cached &&
      canQuickReply(item.payload) &&
      item.sharedRequest.can_reply !== false &&
      item.sharedRequest.status === 'pending' &&
      item.sharedRequest.recipient_user_id !== null
    )
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

function scopedInteractionPayload(payload: RequestUserInputPayload, turnId?: string | null) {
  return payload.interactionScope || !turnId || isAsyncRequestUserInputPayload(payload)
    ? payload
    : { ...payload, interactionScope: turnId }
}

/** Read only explicit settlement evidence; missing or partial history proves nothing. */
export function settledRuntimeInteractionKeys(messages: WorkbenchMessage[]): Set<string> {
  const keys = new Set<string>()
  for (const message of resolveAsyncRequestUserInputAnswers(messages)) {
    for (const block of message.blocks ?? []) {
      if (!isRequestUserInputBlock(block) || !isSettledRequestUserInputBlock(block)) continue
      const key = requestUserInputPayloadKey(
        scopedInteractionPayload(block.renderPayload, message.turnId)
      )
      if (key) keys.add(key)
    }
  }
  return keys
}

/** Read every history page: an async question may outlive several later turns. */
export async function readRuntimeInteractions(
  task: RuntimeTaskReminderItem,
  api: NonNullable<WorkbenchServices['runtimeWorkApi']>
): Promise<RuntimeInteraction[]> {
  const pages: WorkbenchMessage[][] = []
  const sourceMessageIdsByTurn = new Map<string, string[]>()
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
    const transcript = projectRuntimePaneTranscript(response)
    pages.unshift(transcript.messages)
    for (const turn of transcript.turns) {
      if (!turn.id) continue
      sourceMessageIdsByTurn.set(turn.id, [
        ...new Set([
          ...(sourceMessageIdsByTurn.get(turn.id) ?? []),
          ...(turn.clientUserMessageId ? [turn.clientUserMessageId] : []),
          ...turn.items.flatMap(item => (item.type === 'user_message' ? [item.id] : [])),
        ]),
      ])
    }
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
    ISSUE_ORIGIN_TYPES.includes(String(origin.type)) &&
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
      const payload = scopedInteractionPayload(block.renderPayload, message.turnId)
      const answered = isSettledRequestUserInputBlock(block)
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
        createdAt: new Date(message.createdAt ?? task.task.createdAt ?? 0).getTime() || 0,
        answered,
        running,
        project,
        source: interactionSource({ task, project }, origin),
        sourceMessageIds: message.turnId ? sourceMessageIdsByTurn.get(message.turnId) : undefined,
      })
    }
  }
  return [...requests.values()]
}
