// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationGroup, CollaborationProject } from '../types'
import type { CollaborationLocale } from '../i18n'
import type { CollaborationTemplate } from './types'
import { TemplateBindingsDialog, type TemplateParticipant } from './TemplateBindings'
import { TemplateDialog } from './TemplateDialog'
import { templateFailureMessage, templateMessages } from './messages'
import { templateRoutingResolver } from './agents'
import { applyProjectTemplate } from './projectConfiguration'
import { TemplateConfigurationError } from './apply'
import { reconcileCreatedTemplateFailure } from './projectApplyRecovery'
import { TemplateProjectEnvironment } from './TemplateProjectEnvironment'

export function ProjectTemplateApplyDialog({
  api,
  agentConfiguration,
  projectId,
  document,
  locale,
  currentUserId,
  onClose,
  onApplied,
}: {
  api: SharedWorkspaceApi
  agentConfiguration?: ProjectAgentConfigurationHost
  projectId: string
  document: CollaborationTemplate
  locale: CollaborationLocale
  currentUserId?: number
  onClose(): void
  onApplied(project: CollaborationProject): void
}) {
  const m = templateMessages[locale]
  const [attempt, setAttempt] = useState(0)
  const scope = useMemo(
    () => ({ api, projectId, locale, attempt, active: false }),
    [api, projectId, locale, attempt]
  )
  const currentScope = useRef(scope)
  currentScope.current = scope
  const isCurrent = useCallback(() => scope.active && currentScope.current === scope, [scope])
  const close = () => {
    if (!isCurrent()) return
    scope.active = false
    onClose()
  }
  const [loadedContext, setContext] = useState<{
    scope: typeof scope
    project: CollaborationProject
    candidates: TemplateParticipant[]
    names: string[]
  } | null>(null)
  const context = loadedContext?.scope === scope ? loadedContext : null
  const [loadError, setError] = useState<{ scope: typeof scope; message: string } | null>(null)
  const error = loadError?.scope === scope ? loadError.message : null
  const [environmentId, setEnvironmentId] = useState<string>()
  useEffect(() => {
    const { api, projectId, locale } = scope
    const m = templateMessages[locale]
    let active = true
    scope.active = true
    setContext(null)
    setError(null)
    setEnvironmentId(undefined)
    void (async () => {
      const project = await api.projects.get(projectId)
      if (!active || !isCurrent()) return
      if (project.access_role !== 'Owner' && project.access_role !== 'Maintainer')
        throw new TemplateConfigurationError(m.manageRequired)
      const [members, agents, groups] = await Promise.all([
        api.members.list(projectId),
        api.agents.list(projectId),
        api.projects.listCollaborationGroups?.(projectId) ?? Promise.resolve([]),
      ])
      if (!active || !isCurrent()) return
      setContext({
        scope,
        project,
        names: groups.map(group => group.name),
        candidates: [
          ...members.map(member => ({
            kind: 'human' as const,
            id: String(member.user_id),
            name: member.user_name,
            label: member.user_name,
            responsibility: '',
          })),
          ...agents.map(agent => ({
            kind: 'agent' as const,
            id: String(agent.team_id ?? agent.id),
            name: agent.name,
            label: agent.name,
            responsibility: '',
          })),
        ],
      })
    })().catch(cause => {
      if (active && isCurrent())
        setError({
          scope,
          message:
            cause instanceof TemplateConfigurationError
              ? cause.message
              : templateFailureMessage(cause, locale),
        })
    })
    return () => {
      active = false
      scope.active = false
    }
  }, [scope, isCurrent])
  if (!context)
    return (
      <TemplateDialog title={m.bindingsTitle} closeLabel={m.close} onClose={close}>
        {error ? (
          <p role="alert">
            {error}{' '}
            <button
              type="button"
              data-testid="template-project-retry"
              onClick={() => setAttempt(value => value + 1)}
            >
              {m.retry}
            </button>
          </p>
        ) : (
          <p role="status">{m.loading}</p>
        )}
      </TemplateDialog>
    )
  return (
    <TemplateBindingsDialog
      key={projectId}
      document={document}
      locale={locale}
      candidates={context.candidates}
      currentUserId={currentUserId}
      existingNames={context.names}
      onClose={close}
      modelConfiguration={
        agentConfiguration
          ? {
              host: agentConfiguration,
              location: context.project.project_store === 'local' ? 'local' : 'cloud',
              projectId,
              environmentId,
            }
          : undefined
      }
      renderConfiguration={
        agentConfiguration?.listTemplateAgentEnvironments &&
        document.spec.resources.collaboration.agents?.length
          ? disabled => (
              <TemplateProjectEnvironment
                host={agentConfiguration}
                project={context.project}
                locale={locale}
                selected={environmentId}
                disabled={disabled}
                onChange={setEnvironmentId}
              />
            )
          : undefined
      }
      onApply={async (drafts, configured, resolveRouting) => {
        if (!isCurrent()) return
        const onGroupsRefreshed = (groups: CollaborationGroup[]) =>
          setContext(current =>
            isCurrent() && current?.scope === scope
              ? { ...current, names: groups.map(group => group.name) }
              : current
          )
        const createdGroups = await applyProjectTemplate(
          api,
          projectId,
          configured,
          drafts,
          locale,
          m.partial,
          resolveRouting ?? templateRoutingResolver(environmentId),
          onGroupsRefreshed
        )
        if (!isCurrent()) return
        try {
          const project = await api.projects.get(projectId)
          if (isCurrent()) onApplied(project)
        } catch (cause) {
          if (!isCurrent()) return
          throw await reconcileCreatedTemplateFailure(cause, {
            api,
            projectId,
            locale,
            createdGroups,
            onGroupsRefreshed,
          })
        }
      }}
    />
  )
}
