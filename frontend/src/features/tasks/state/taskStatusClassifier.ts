// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskStatus as ApiTaskStatus } from '@/types/api'

export type TaskRuntimePhase =
  | 'unknown'
  | 'syncing'
  | 'running'
  | 'streaming'
  | 'waiting_for_user'
  | 'terminal'
  | 'error'

const ACTIVE_EXECUTION_STATUSES = new Set<ApiTaskStatus>(['PENDING', 'RUNNING', 'CANCELLING'])
const TERMINAL_TASK_STATUSES = new Set<ApiTaskStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'DELETE',
])
const WAITING_FOR_USER_STATUSES = new Set<ApiTaskStatus>(['PENDING_CONFIRMATION'])

export function isActiveExecutionTaskStatus(status?: ApiTaskStatus | null): boolean {
  return Boolean(status && ACTIVE_EXECUTION_STATUSES.has(status))
}

export function isTerminalTaskStatus(status?: ApiTaskStatus | null): boolean {
  return Boolean(status && TERMINAL_TASK_STATUSES.has(status))
}

export function isWaitingForUserTaskStatus(status?: ApiTaskStatus | null): boolean {
  return Boolean(status && WAITING_FOR_USER_STATUSES.has(status))
}

export function getRuntimePhaseForTaskStatus(
  status: ApiTaskStatus | undefined | null,
  hasActiveStream: boolean
): TaskRuntimePhase {
  if (isTerminalTaskStatus(status)) return 'terminal'
  if (isWaitingForUserTaskStatus(status)) return 'waiting_for_user'
  if (isActiveExecutionTaskStatus(status)) return hasActiveStream ? 'streaming' : 'running'
  return 'unknown'
}
