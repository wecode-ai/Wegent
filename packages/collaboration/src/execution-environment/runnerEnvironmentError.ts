// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from '../i18n'

interface EnvironmentIdentity {
  id: string
  name?: string | null
}

interface RoutingContext {
  issue_id?: string
  agent_id?: string
  agent_name?: string | null
  group_id?: string
  group_name?: string | null
  reason?: string
  bound_environment?: EnvironmentIdentity | null
  policy_environment?: EnvironmentIdentity | null
  authorized_environments?: EnvironmentIdentity[]
  members?: {
    agent_id: string
    agent_name?: string
    environment_ids: string[]
  }[]
}

const reasons = new Set([
  'policy_mismatch',
  'workspace_authorization_missing',
  'project_authorization_missing',
  'environment_unavailable',
  'no_authorized_environment',
  'history_requires_configuration',
  'group_no_common_environment',
])

const environmentLabel = (environment: EnvironmentIdentity) =>
  environment.name ? `${environment.name} (${environment.id})` : environment.id

/** Translate the routing denial without treating it as an authentication error. */
export function runnerEnvironmentError(
  error: unknown,
  translate: CollaborationTranslate,
): string | null {
  if (!error || typeof error !== 'object') return null
  const value = error as {
    errorCode?: string
    error_code?: string
    detail?: { error_code?: string; routing_context?: RoutingContext }
  }
  const code = value.errorCode ?? value.error_code ?? value.detail?.error_code
  if (
    !code ||
    ![
      'RUNNER_ENVIRONMENT_UNAVAILABLE',
      'ISSUE_RUNNER_CONFLICT',
      'ISSUE_RUNNER_CONFIGURATION_REQUIRED',
    ].includes(code)
  )
    return null
  const context = value.detail?.routing_context
  const parts = [
    translate(
      code === 'RUNNER_ENVIRONMENT_UNAVAILABLE'
        ? 'todo.runner_environment_not_authorized'
        : 'todo.runner_issue_conflict',
    ),
  ]
  if (context) {
    if (context.group_name || context.group_id)
      parts.push(
        translate('todo.runner_diagnostic_group', undefined, {
          name: context.group_name || context.group_id || '',
        }),
      )
    if (context.agent_name || context.agent_id)
      parts.push(
        translate('todo.runner_diagnostic_agent', undefined, {
          name: context.agent_name || context.agent_id || '',
        }),
      )
    if (context.reason && reasons.has(context.reason))
      parts.push(translate(`todo.runner_reason_${context.reason}`))
    if (context.bound_environment)
      parts.push(
        translate('todo.runner_diagnostic_bound', undefined, {
          environment: environmentLabel(context.bound_environment),
        }),
      )
    if (context.policy_environment)
      parts.push(
        translate('todo.runner_diagnostic_fixed', undefined, {
          environment: environmentLabel(context.policy_environment),
        }),
      )
    if (context.authorized_environments?.length)
      parts.push(
        translate('todo.runner_diagnostic_authorized', undefined, {
          environments: context.authorized_environments
            .map(environmentLabel)
            .join(', '),
        }),
      )
    for (const member of context.members ?? [])
      parts.push(
        `${member.agent_name || member.agent_id}: ${member.environment_ids.join(', ')}`,
      )
  }
  return `${parts.join(' ')} [${code}]`
}
