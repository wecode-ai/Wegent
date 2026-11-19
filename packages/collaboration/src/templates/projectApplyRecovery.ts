// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationLocale } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup } from '../types'
import { PartialTemplateApplyError, TemplateConfigurationError } from './apply'
import { templateFailureMessage, templateMessages } from './messages'

// Outcomes describe this attempt, independently of concurrent project changes.
export type TemplateApplyOutcome = 'unchanged' | 'partial' | 'unknown'

interface ProjectApplyRecovery {
  api: SharedWorkspaceApi
  projectId: string
  locale: CollaborationLocale
  groupNames: string[]
  baselineGroups?: CollaborationGroup[]
  baselineAgentIds?: Set<string>
  agentNames: string[]
  unconfirmedAgentCreation: boolean
  mutationStarted: boolean
  createdAgents: boolean
  createdGroups: CollaborationGroup[]
  onGroupsRefreshed?(groups: CollaborationGroup[]): void
}

export class TemplateApplyRecoveryError extends TemplateConfigurationError {
  readonly retryBlocked: boolean
  readonly outcome: TemplateApplyOutcome
  readonly recheck: () => Promise<TemplateApplyRecoveryError>

  constructor(
    message: string,
    outcome: TemplateApplyOutcome,
    recheck: () => Promise<TemplateApplyRecoveryError>,
    options: ErrorOptions
  ) {
    super(message, options)
    this.retryBlocked = outcome !== 'unchanged'
    this.outcome = outcome
    this.recheck = recheck
  }
}

export function reconcileCreatedTemplateFailure(
  cause: unknown,
  recovery: Pick<
    ProjectApplyRecovery,
    'api' | 'projectId' | 'locale' | 'createdGroups' | 'onGroupsRefreshed'
  >
) {
  return reconcileProjectTemplateFailure(cause, {
    ...recovery,
    groupNames: recovery.createdGroups.map(group => group.name),
    agentNames: [],
    unconfirmedAgentCreation: false,
    mutationStarted: true,
    createdAgents: false,
  })
}

function originalFailure(cause: unknown): unknown {
  const visited = new Set<unknown>()
  while (cause instanceof PartialTemplateApplyError && cause.cause && !visited.has(cause)) {
    visited.add(cause)
    cause = cause.cause
  }
  return cause
}

function mutationWasRejected(cause: unknown): boolean {
  return (
    !!cause &&
    typeof cause === 'object' &&
    'status' in cause &&
    typeof cause.status === 'number' &&
    [400, 401, 403, 404, 409, 422].includes(cause.status)
  )
}

/** Distinguish acknowledged writes from list changes that may belong to another request. */
export async function reconcileProjectTemplateFailure(
  cause: unknown,
  recovery: ProjectApplyRecovery
): Promise<TemplateApplyRecoveryError> {
  const m = templateMessages[recovery.locale]
  const failure = originalFailure(cause)
  const rejected = mutationWasRejected(failure)
  let refreshed: CollaborationGroup[] | undefined
  try {
    refreshed = await recovery.api.projects.listCollaborationGroups?.(recovery.projectId)
    if (refreshed) recovery.onGroupsRefreshed?.(refreshed)
  } catch {
    // The original mutation error remains the cause when reconciliation also fails.
  }
  let observedAgents = false
  if (recovery.unconfirmedAgentCreation && !rejected && recovery.baselineAgentIds) {
    try {
      const agents = await recovery.api.agents.list(recovery.projectId, { forceRefresh: true })
      observedAgents = agents.some(
        agent =>
          !recovery.baselineAgentIds!.has(String(agent.team_id ?? agent.id)) &&
          recovery.agentNames.includes(agent.name)
      )
    } catch {
      // Group reads cannot establish the outcome of a lost Agent creation response.
    }
  }
  const previousIds = new Set(recovery.baselineGroups?.map(group => group.id))
  const observed =
    refreshed && recovery.baselineGroups
      ? refreshed.filter(
          group => !previousIds.has(group.id) && recovery.groupNames.includes(group.name)
        )
      : []
  // A new ID and matching name do not establish which request created the resource.
  const created = recovery.createdGroups
  const hasPartialWork =
    created.length > 0 || recovery.createdAgents || cause instanceof PartialTemplateApplyError
  // Empty reads cannot prove that a failed request has stopped processing on the server.
  const outcome: TemplateApplyOutcome = hasPartialWork
    ? 'partial'
    : !recovery.mutationStarted || rejected
      ? 'unchanged'
      : 'unknown'
  const reason = templateFailureMessage(failure, recovery.locale)
  const stateMessage = created.length
    ? m.groupsCreated.replace('{names}', created.map(group => group.name).join('、'))
    : hasPartialWork
      ? m.partial
      : !recovery.mutationStarted
        ? m.groupsNotStarted
        : rejected
          ? m.groupsRejected
          : observed.length
            ? m.groupsObserved.replace('{names}', observed.map(group => group.name).join('、'))
            : observedAgents
              ? m.agentsObserved
              : recovery.unconfirmedAgentCreation
                ? m.agentsUnknown
                : m.groupsUnknown
  const refreshMessage =
    !refreshed && recovery.mutationStarted && hasPartialWork ? ` ${m.groupsRefreshFailed}` : ''
  return new TemplateApplyRecoveryError(
    `${reason} ${stateMessage}${refreshMessage}`,
    outcome,
    () => reconcileProjectTemplateFailure(cause, recovery),
    { cause }
  )
}
