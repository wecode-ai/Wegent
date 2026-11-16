// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationProject } from '../types'
import type { CollaborationLocale } from '../i18n'
import type { CollaborationTemplate } from './types'
import { TemplateBindingsDialog, type TemplateParticipant } from './TemplateBindings'
import { TemplateDialog } from './TemplateDialog'
import { templateFailureMessage, templateMessages } from './messages'
import { templateAgentId, templateAgentReferences, templateRoutingResolver } from './agents'
import { applyProjectTemplate } from './projectConfiguration'
import { PartialTemplateApplyError, TemplateConfigurationError } from './apply'
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
  const [context, setContext] = useState<{
    project: CollaborationProject
    candidates: TemplateParticipant[]
    names: string[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [environmentId, setEnvironmentId] = useState<string>()
  useEffect(() => {
    let active = true
    setContext(null)
    setError(null)
    void (async () => {
      const project = await api.projects.get(projectId)
      if (project.access_role !== 'Owner' && project.access_role !== 'Maintainer')
        throw new TemplateConfigurationError(m.manageRequired)
      const [members, agents, groups] = await Promise.all([
        api.members.list(projectId),
        api.agents.list(projectId),
        api.projects.listCollaborationGroups?.(projectId) ?? Promise.resolve([]),
      ])
      if (!active) return
      setContext({
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
      if (active)
        setError(
          cause instanceof TemplateConfigurationError
            ? cause.message
            : templateFailureMessage(cause, locale)
        )
    })
    return () => {
      active = false
    }
  }, [api, projectId, locale, m.manageRequired, attempt])
  if (!context)
    return (
      <TemplateDialog title={m.bindingsTitle} closeLabel={m.close} onClose={onClose}>
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
      onClose={onClose}
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
        if (
          agentConfiguration?.listTemplateAgentEnvironments &&
          !environmentId &&
          configured.spec.resources.collaboration.agents?.some(agent =>
            templateAgentReferences(drafts).has(templateAgentId(agent.key))
          )
        ) {
          throw new TemplateConfigurationError(m.chooseProjectEnvironment)
        }
        await applyProjectTemplate(
          api,
          projectId,
          configured,
          drafts,
          locale,
          m.partial,
          resolveRouting ??
            templateRoutingResolver(
              agentConfiguration,
              context.project.project_store === 'local' ? 'local' : 'cloud',
              projectId,
              locale,
              environmentId
            )
        )
        try {
          onApplied(await api.projects.get(projectId))
        } catch (cause) {
          throw new PartialTemplateApplyError(m.partial, { cause })
        }
      }}
    />
  )
}
