// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export type AssistantRequestAction =
  | { action: 'new_request'; message: string; parentRequestId?: string }
  | { action: 'followup'; requestId: string; message: string }
  | { action: 'cancel'; requestId: string }
  | { action: 'retry'; requestId: string }
  | { action: 'prepare_merge'; requestId: string }
  | { action: 'replace'; requestId: string; message: string }

export type AssistantRequestSubmission = AssistantRequestAction & {
  idempotencyKey: string
}

export interface AssistantRequestMergeConfirmation {
  idempotencyKey: string
  targetRevision: string
  candidateRevision: string
}

export interface AssistantRequestWorktree {
  worktreeId: string
  deviceId: string
  request: {
    requestId: string
    ownerUserId: number
    conversationId: string
    deviceId: string
  }
  sourcePath: string | null
  baseRevision: string | null
  branch: string | null
  path: string | null
  state: string | null
  cleanupPolicy: string | null
  merge: {
    state: string
    targetRef: string
    targetRevision: string
    requestRevision: string
    candidateRevision: string | null
    mergedRevision: string | null
    conflictFiles: string[]
    reasonCode: string | null
    observedTargetRevision?: string | null
    targetWorktreeDirty?: boolean
  } | null
}

export type AssistantRequestCommand =
  | {
      id: string
      action: 'prepare_merge'
      executionId: string
      acknowledged: boolean
      reasonCode?: string | null
    }
  | {
      id: string
      action: 'followup'
      message: string
      acknowledged: boolean
      executionId: string
      reasonCode?: string | null
    }
  | {
      id: string
      action: 'merge'
      approvedByUserId: number
      targetRevision: string
      candidateRevision: string
      acknowledged: boolean
      executionId: string
      reasonCode?: string | null
    }

export interface AssistantExecutionRequest {
  requestId: string
  parentRequestId: string | null
  ownerUserId: number
  deviceId: string
  runtimeTaskId: string
  conversationId: string
  executionId: string
  state: string
  queuePosition: number | null
  reasonCode: string | null
  updatedAt: string
  message: string
  commands: AssistantRequestCommand[]
  worktree?: AssistantRequestWorktree
}

export interface AssistantRequestList {
  enabled: boolean
  requests: AssistantExecutionRequest[]
}

/** Explicit execution actions; semantic message classification belongs to the caller. */
export interface AssistantRequestsApi {
  list(projectId: string, issueId: string): Promise<AssistantRequestList>
  submit(
    projectId: string,
    issueId: string,
    input: AssistantRequestSubmission,
  ): Promise<AssistantExecutionRequest>
  /** Requires the owner's interactive session; task and API tokens cannot approve a merge. */
  confirmMerge(
    projectId: string,
    issueId: string,
    requestId: string,
    input: AssistantRequestMergeConfirmation,
  ): Promise<AssistantExecutionRequest>
}
