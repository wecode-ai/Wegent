// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource, createAsyncResource } from '@wegent/chat-core/async-resource'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { CollaborationProject } from '../types'
import type { CollaborationLocale } from '../i18n'
import type { CollaborationTemplate } from './types'
import { TemplateBindingsDialog } from './TemplateBindings'
import {
  loadTemplateProjectContext,
  TemplateProjectManagementRequiredError,
} from './templateProjectContext'
import { TemplateDialog } from './TemplateDialog'
import { templateFailureMessage, templateMessages } from './messages'
import { templateRoutingResolver } from './agents'
import { applyProjectTemplate } from './projectConfiguration'
import { PartialTemplateApplyError, TemplateConfigurationError } from './apply'
import { TemplateProjectEnvironment } from './TemplateProjectEnvironment'
import { createTemplateProjectEnvironmentResource } from './templateProjectEnvironmentResource'

const noEnvironment = () => undefined

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
  const resource = useMemo(
    () =>
      createAsyncResource(projectId, signal => loadTemplateProjectContext(api, projectId, signal)),
    [api, projectId]
  )
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot)
  const context = state.data
  const error =
    state.status !== 'error'
      ? undefined
      : state.error instanceof TemplateProjectManagementRequiredError
        ? m.manageRequired
        : state.error instanceof TemplateConfigurationError
          ? state.error.message
          : templateFailureMessage(state.error, locale)
  const environmentProject = context?.project
  const environmentResource = useMemo(
    () =>
      environmentProject && agentConfiguration?.listTemplateAgentEnvironments
        ? createTemplateProjectEnvironmentResource(agentConfiguration, environmentProject)
        : undefined,
    [agentConfiguration, environmentProject]
  )
  const environmentId = useSyncExternalStore(
    environmentResource?.subscribeSelection ?? subscribeIdleResource,
    environmentResource?.getSelection ?? noEnvironment,
    environmentResource?.getSelection ?? noEnvironment
  )
  if (!context)
    return (
      <TemplateDialog title={m.bindingsTitle} closeLabel={m.close} onClose={onClose}>
        {error ? (
          <p role="alert">
            {error}{' '}
            <button
              type="button"
              data-testid="template-project-retry"
              onClick={() => void resource.reload()}
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
        environmentResource && document.spec.resources.collaboration.agents?.length
          ? disabled => (
              <TemplateProjectEnvironment
                resource={environmentResource}
                locale={locale}
                disabled={disabled}
              />
            )
          : undefined
      }
      onApply={async (drafts, configured, resolveRouting) => {
        await applyProjectTemplate(
          api,
          projectId,
          configured,
          drafts,
          locale,
          m.partial,
          resolveRouting ?? templateRoutingResolver(environmentId)
        )
        try {
          const latest = await api.projects.get(projectId)
          if (resource.hasSubscribers()) onApplied(latest)
        } catch (cause) {
          throw new PartialTemplateApplyError(m.partial, { cause })
        }
      }}
    />
  )
}
