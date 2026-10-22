// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from '../i18n'

// These messages are the existing workspace/project authorization API contract.
const authorizationErrors: Record<string, string> = {
  'Share the environment with this Workspace before authorizing it for a Project':
    'todo.execution_environment_workspace_share_required',
  'Execution environment is already available in this Workspace':
    'todo.execution_environment_already_shared',
  'Execution environment is already available in this Project':
    'todo.execution_environment_already_added',
  'Owned execution environment not found': 'todo.execution_environment_owned_not_found',
  'Execution environment not found': 'todo.execution_environment_not_found',
  'Workspace not found': 'todo.execution_environment_workspace_not_found',
  'Project is not attached to a Workspace': 'todo.execution_environment_workspace_required',
  'Insufficient permission': 'todo.execution_environment_permission_denied',
  'Invalid Workspace role': 'todo.execution_environment_permission_denied',
}

export function environmentAuthorizationError(
  error: unknown,
  translate: CollaborationTranslate
): string {
  const message = error instanceof Error ? error.message : String(error)
  const key = authorizationErrors[message]
  return key ? translate(key) : message
}
