// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationLocale } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup } from '../types'
import { PartialTemplateApplyError, TemplateConfigurationError } from './apply'
import { templateFailureMessage, templateMessages } from './messages'

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

/** Reconcile writes using persisted identities, including a lost POST response. */
export async function reconcileProjectTemplateFailure(
  cause: unknown,
  recovery: ProjectApplyRecovery
): Promise<TemplateApplyRecoveryError> {
  const m = templateMessages[recovery.locale]
  let refreshed: CollaborationGroup[] | undefined
  try {
    refreshed = await recovery.api.projects.listCollaborationGroups?.(recovery.projectId)
    if (refreshed) recovery.onGroupsRefreshed?.(refreshed)
  } catch {
    // The original mutation error remains the cause when reconciliation also fails.
  }
  let agentsConfirmed = !recovery.unconfirmedAgentCreation
  if (!agentsConfirmed && recovery.baselineAgentIds) {
    try {
      const agents = await recovery.api.agents.list(recovery.projectId, { forceRefresh: true })
      recovery.createdAgents ||= agents.some(
        agent =>
          !recovery.baselineAgentIds!.has(String(agent.team_id ?? agent.id)) &&
          recovery.agentNames.includes(agent.name)
      )
      agentsConfirmed = true
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
  const created = [
    ...new Map([...recovery.createdGroups, ...observed].map(group => [group.id, group])).values(),
  ]
  const hasPartialWork =
    created.length > 0 || recovery.createdAgents || cause instanceof PartialTemplateApplyError
  const outcome: TemplateApplyOutcome = hasPartialWork
    ? 'partial'
    : !recovery.mutationStarted || (refreshed && recovery.baselineGroups && agentsConfirmed)
      ? 'unchanged'
      : 'unknown'
  const reason = templateFailureMessage(originalFailure(cause), recovery.locale)
  const stateMessage = created.length
    ? m.groupsCreated.replace('{names}', created.map(group => group.name).join('、'))
    : hasPartialWork
      ? m.partial
      : !agentsConfirmed
        ? m.agentsUnknown
        : refreshed && recovery.baselineGroups
          ? m.groupsUnchanged
          : recovery.mutationStarted
            ? m.groupsUnknown
            : m.groupsNotStarted
  const refreshMessage =
    !refreshed && recovery.mutationStarted && hasPartialWork ? ` ${m.groupsUnknown}` : ''
  return new TemplateApplyRecoveryError(
    `${reason} ${stateMessage}${refreshMessage}`,
    outcome,
    () => reconcileProjectTemplateFailure(cause, recovery),
    { cause }
  )
}
