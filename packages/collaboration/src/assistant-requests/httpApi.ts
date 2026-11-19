// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceHttpTransport } from '../http-api/createSharedWorkspaceHttpApi'
import type {
  AssistantExecutionRequest,
  AssistantRequestCommand,
  AssistantRequestsApi,
  AssistantRequestWorktree,
} from './types'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid assistant request response')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('Invalid assistant request field')
  return value
}

function optionalText(value: unknown): string | null {
  return value == null ? null : text(value)
}

function worktree(
  value: unknown,
  requestId: string,
  ownerUserId: number,
  conversationId: string,
): AssistantRequestWorktree {
  const row = record(value)
  const owner = record(row.request)
  if (
    owner.requestId !== requestId ||
    owner.ownerUserId !== ownerUserId ||
    owner.conversationId !== conversationId
  )
    throw new Error('Invalid assistant request worktree owner')
  const merge = row.merge == null ? null : record(row.merge)
  if (merge && !Array.isArray(merge.conflictFiles))
    throw new Error('Invalid assistant request conflicts')
  if (
    merge?.targetWorktreeDirty != null &&
    typeof merge.targetWorktreeDirty !== 'boolean'
  )
    throw new Error('Invalid assistant request target checkout state')
  return {
    worktreeId: text(row.worktreeId),
    deviceId: text(row.deviceId),
    request: {
      requestId,
      ownerUserId,
      conversationId,
      deviceId: text(owner.deviceId),
    },
    sourcePath: optionalText(row.sourcePath),
    baseRevision: optionalText(row.baseRevision),
    branch: optionalText(row.branch),
    path: optionalText(row.path),
    state: optionalText(row.state),
    cleanupPolicy: optionalText(row.cleanupPolicy),
    merge: merge
      ? {
          state: text(merge.state),
          targetRef: text(merge.targetRef),
          targetRevision: text(merge.targetRevision),
          requestRevision: text(merge.requestRevision),
          candidateRevision: optionalText(merge.candidateRevision),
          mergedRevision: optionalText(merge.mergedRevision),
          conflictFiles: (merge.conflictFiles as unknown[]).map(text),
          reasonCode: optionalText(merge.reasonCode),
          ...(merge.observedTargetRevision == null
            ? {}
            : { observedTargetRevision: text(merge.observedTargetRevision) }),
          ...(typeof merge.targetWorktreeDirty !== 'boolean'
            ? {}
            : { targetWorktreeDirty: merge.targetWorktreeDirty }),
        }
      : null,
  }
}

function command(value: unknown): AssistantRequestCommand {
  const row = record(value)
  if (typeof row.acknowledged !== 'boolean')
    throw new Error('Invalid assistant request command acknowledgement')
  const common = {
    id: text(row.id),
    acknowledged: row.acknowledged,
    executionId: text(row.executionId),
    ...(row.reasonCode == null ? {} : { reasonCode: text(row.reasonCode) }),
  }
  if (row.action === 'followup')
    return { ...common, action: 'followup', message: text(row.message) }
  if (row.action === 'prepare_merge')
    return { ...common, action: 'prepare_merge' }
  if (row.action === 'merge' && Number.isSafeInteger(row.approvedByUserId))
    return {
      ...common,
      action: 'merge',
      approvedByUserId: Number(row.approvedByUserId),
      targetRevision: text(row.targetRevision),
      candidateRevision: text(row.candidateRevision),
    }
  throw new Error('Invalid assistant request command')
}

function request(value: unknown): AssistantExecutionRequest {
  const row = record(value)
  if (!Number.isSafeInteger(row.ownerUserId) || !Array.isArray(row.commands))
    throw new Error('Invalid assistant request ownership')
  if (
    row.queuePosition != null &&
    (!Number.isSafeInteger(row.queuePosition) || Number(row.queuePosition) < 1)
  )
    throw new Error('Invalid assistant request queue position')
  return {
    requestId: text(row.requestId),
    parentRequestId: optionalText(row.parentRequestId),
    ownerUserId: Number(row.ownerUserId),
    deviceId: text(row.deviceId),
    runtimeTaskId: text(row.runtimeTaskId),
    conversationId: text(row.conversationId),
    executionId: text(row.executionId),
    state: text(row.state),
    queuePosition: row.queuePosition == null ? null : Number(row.queuePosition),
    reasonCode: optionalText(row.reasonCode),
    updatedAt: text(row.updatedAt),
    message: text(row.message),
    commands: row.commands.map(command),
    ...(row.worktree == null
      ? {}
      : {
          worktree: worktree(
            row.worktree,
            text(row.requestId),
            Number(row.ownerUserId),
            text(row.conversationId),
          ),
        }),
  }
}

export function createAssistantRequestsHttpApi(
  transport: Pick<SharedWorkspaceHttpTransport, 'get' | 'post'>,
): AssistantRequestsApi {
  const path = (projectId: string, issueId: string) =>
    `/v1/cloud-projects/${encodeURIComponent(projectId)}/loop-items/${encodeURIComponent(issueId)}/assistant-requests`
  return {
    async list(projectId, issueId) {
      const value = record(await transport.get(path(projectId, issueId)))
      if (typeof value.enabled !== 'boolean' || !Array.isArray(value.requests))
        throw new Error('Invalid assistant request list')
      return { enabled: value.enabled, requests: value.requests.map(request) }
    },
    async submit(projectId, issueId, input) {
      // This API has an explicit camelCase contract; do not transform message or identity fields.
      return request(await transport.post(path(projectId, issueId), input))
    },
    async confirmMerge(projectId, issueId, requestId, input) {
      return request(
        await transport.post(
          `${path(projectId, issueId)}/${encodeURIComponent(requestId)}/merge`,
          input,
        ),
      )
    },
  }
}
