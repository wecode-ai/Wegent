import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationAgent, CollaborationGroup, CollaborationMember } from '../types'
import { WorkspaceCollaborationGroupsConfiguration } from '../platform/WorkspaceResourceConfiguration'
import { createSharedAgentBindingInput } from '../project-agent-config/model'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import { readTemplateAgents, templateRoutingResolver } from '../templates/agents'
import { applyProjectTemplate } from '../templates/projectConfiguration'
import { templateMessages } from '../templates/messages'
import { createCollaborationTranslator } from '../i18n'
import { requestFailureMessage } from '../controls/requestFailure'
import {
  useProjectSettingsRefresh,
  ProjectSettingsRefreshFeedback,
} from './useProjectSettingsRefresh'

function ScopedProjectCollaborationGroups({
  api,
  projectId,
  workspaceId,
  members,
  agents,
  locale,
  currentUserId,
  canManage,
  location = 'cloud',
  agentConfiguration,
  agentResourceContext,
  onProjectChanged,
}: {
  api: SharedWorkspaceApi
  projectId: string
  workspaceId?: string | null
  members: CollaborationMember[]
  agents: CollaborationAgent[]
  locale: 'zh-CN' | 'en'
  currentUserId?: number
  canManage: boolean
  onProjectChanged?(project: import('../types').CollaborationProject): void
  location?: 'local' | 'cloud'
  agentConfiguration?: ProjectAgentConfigurationHost
  agentResourceContext?: {
    name: string
    namespace: string
  }
}) {
  const collectionResource = useMemo(
    () =>
      createAsyncResource(
        'project-groups:' + projectId,
        async () => {
          if (!api.projects.listCollaborationGroups)
            throw new Error('Project collaboration group API is unavailable')
          const [workspaceGroups, groups, agents] = await Promise.all([
            workspaceId && api.workspaces?.listCollaborationGroups
              ? api.workspaces.listCollaborationGroups(workspaceId)
              : Promise.resolve([]),
            api.projects.listCollaborationGroups(projectId),
            api.agents.list(projectId),
          ])
          return { workspaceGroups, groups, agents }
        },
        { refreshOnSubscribe: true }
      ),
    [api, projectId, workspaceId]
  )
  const reloadRevision = useRef(0)
  const subscribeCollection = useCallback(
    (listener: () => void) => {
      if (!collectionResource.hasSubscribers()) reloadRevision.current++
      return collectionResource.subscribe(listener)
    },
    [collectionResource]
  )
  const collection = useSyncExternalStore(
    subscribeCollection,
    collectionResource.getSnapshot,
    collectionResource.getSnapshot
  )
  const [initialMembers] = useState(members)
  const membersResource = useMemo(
    () =>
      createAsyncResource('group-members:' + projectId, () => api.members.list(projectId), {
        initialData: initialMembers,
        refreshOnSubscribe: true,
      }),
    [api, projectId, initialMembers]
  )
  const memberSnapshot = useSyncExternalStore(
    membersResource.subscribe,
    membersResource.getSnapshot,
    membersResource.getSnapshot
  )
  const availableMembers = memberSnapshot.data ?? initialMembers
  const membersError =
    memberSnapshot.status === 'error'
      ? String(
          memberSnapshot.error instanceof Error
            ? memberSnapshot.error.message
            : memberSnapshot.error
        )
      : null
  const groups = collection.data?.groups ?? []
  const workspaceGroups = collection.data?.workspaceGroups ?? []
  const collectionState =
    collection.status === 'ready' ? 'ready' : collection.status === 'error' ? 'error' : 'loading'
  const groupsError =
    collection.status === 'error'
      ? String(collection.error instanceof Error ? collection.error.message : collection.error)
      : null
  const [agentCatalog, setAgentCatalog] = useState({
    data: collection.data,
    source: agents,
    value: agents,
  })
  if (agentCatalog.data !== collection.data) {
    setAgentCatalog({
      data: collection.data,
      source: agents,
      value: collection.data?.agents ?? agents,
    })
  } else if (agentCatalog.source !== agents) {
    setAgentCatalog({ ...agentCatalog, source: agents, value: agents })
  }
  const availableAgents = agentCatalog.value
  const projectRefresh = useProjectSettingsRefresh(api, projectId, onProjectChanged)
  const translate = createCollaborationTranslator(locale)
  const requireActive = () => {
    if (!collectionResource.hasSubscribers())
      throw new Error('Collaboration group scope is no longer active')
  }
  const reload = useCallback(async () => {
    if (!collectionResource.hasSubscribers()) return []
    const revision = ++reloadRevision.current
    await collectionResource.reload()
    if (!collectionResource.hasSubscribers() || revision !== reloadRevision.current) return []
    const snapshot = collectionResource.getSnapshot()
    if (snapshot.status === 'error') throw snapshot.error
    return snapshot.data?.agents ?? []
  }, [collectionResource])
  async function reloadAfterMutation() {
    if (!collectionResource.hasSubscribers()) return
    await projectRefresh.refresh()
    if (collectionResource.hasSubscribers()) await reload()
  }

  const projectGroupIds = new Set(groups.map(group => group.id))
  const agentActions =
    canManage && agentConfiguration
      ? {
          ...((location === 'local' && agentConfiguration.renderLocalAgentCreator) ||
          (location === 'cloud' && agentConfiguration.renderAgentCreator)
            ? {
                renderCreator: ({
                  onClose,
                  onCreated,
                }: {
                  onClose(): void
                  onCreated(agent: CollaborationAgent): Promise<void>
                }) => {
                  if (location === 'local' && agentConfiguration.renderLocalAgentCreator) {
                    const known = new Set(availableAgents.map(agent => agent.id))
                    return agentConfiguration.renderLocalAgentCreator({
                      projectId,
                      onClose,
                      onCreated: async agentId => {
                        requireActive()
                        const projectAgents = await reload()
                        requireActive()
                        const candidates = projectAgents.filter(agent =>
                          agentId ? agent.id === agentId : !known.has(agent.id)
                        )
                        const created = candidates.length === 1 ? candidates[0] : undefined
                        if (!created) {
                          throw new Error('Created collaboration group agent was not found')
                        }
                        await onCreated(created)
                      },
                    })
                  }
                  if (!agentConfiguration.renderAgentCreator) return null
                  return agentConfiguration.renderAgentCreator({
                    namespace: agentResourceContext?.namespace ?? 'default',
                    workspaceName:
                      agentResourceContext?.name ??
                      (locale === 'zh-CN' ? '当前分组' : 'Current group'),
                    onClose,
                    onCreated: async resource => {
                      requireActive()
                      const created = await api.agents.create(
                        projectId,
                        createSharedAgentBindingInput({ name: resource.name, team_id: resource.teamId })
                      )
                      await reload()
                      requireActive()
                      await onCreated(created)
                    },
                  })
                },
              }
            : {}),
          ...(location === 'local'
            ? {
                copy: async (source: CollaborationAgent) => {
                  requireActive()
                  const record = source as CollaborationAgent & Record<string, unknown>
                  const suffix = crypto.randomUUID().slice(0, 8)
                  const created = await api.agents.create(projectId, {
                    ...record,
                    id: undefined,
                    version: undefined,
                    name: `copied-agent-${suffix}`,
                    displayName: locale === 'zh-CN' ? `${source.name} 副本` : `${source.name} copy`,
                  })
                  await reload()
                  return created
                },
              }
            : {}),
        }
      : undefined

  return (
    <>
      <ProjectSettingsRefreshFeedback
        {...projectRefresh}
        testId="project-groups-refresh"
        translate={translate}
      />
      {groupsError ? (
        <div className="collaboration-alert" role="alert" data-testid="project-groups-load-error">
          {locale === 'zh-CN' ? '加载协作小组失败：' : 'Failed to load collaboration groups: '}
          {requestFailureMessage(
            groupsError,
            translate('todo.settings_connection_failed', '无法连接服务，请检查连接后重试。')
          )}
          <ControlButton variant="unstyled"
            type="button"
            className="collaboration-link-button"
            data-testid="project-groups-load-retry"
            onClick={() => void reload().catch(() => {})}
          >
            {locale === 'zh-CN' ? '重试' : 'Retry'}
          </ControlButton>
        </div>
      ) : null}
      {membersError ? (
        <div className="collaboration-alert" role="alert" data-testid="project-group-members-error">
          {locale === 'zh-CN' ? '加载项目成员失败：' : 'Failed to load project members: '}
          {requestFailureMessage(
            membersError,
            translate('todo.settings_connection_failed', '无法连接服务，请检查连接后重试。')
          )}
          <ControlButton variant="unstyled"
            className="collaboration-link-button"
            data-testid="project-group-members-retry"
            onClick={() => void membersResource.reload()}
            type="button"
          >
            {locale === 'zh-CN' ? '重试' : 'Retry'}
          </ControlButton>
        </div>
      ) : null}
      {canManage && api.projects.adoptPersonalTeam &&
        agentConfiguration?.renderPersonalTeamAdoption?.({
          projectId, location,
          agents: availableAgents,
          adopt: async input => {
            requireActive()
            await api.projects.adoptPersonalTeam!(projectId, input)
            await reloadAfterMutation()
          },
        })}
      <WorkspaceCollaborationGroupsConfiguration
        groups={groups}
        collectionState={collectionState}
        availableGroups={workspaceGroups.filter(group => !projectGroupIds.has(group.id))}
        members={availableMembers}
        agents={availableAgents}
        locale={locale}
        currentUserId={currentUserId}
        includeCurrentUserByDefault={false}
        canManage={canManage}
        agentActions={agentActions}
        commands={{
          async loadTemplateAgents(group) {
            return readTemplateAgents(
              await api.agents.list(projectId, { forceRefresh: true }),
              [group],
              agentConfiguration?.readTemplateAgent
            )
          },
          async createTemplateGroups(document, drafts) {
            requireActive()
            const created = await applyProjectTemplate(
              api,
              projectId,
              document,
              drafts,
              locale,
              templateMessages[locale].partial,
              templateRoutingResolver()
            )
            await reloadAfterMutation()
            return created
          },
          searchUsers: async () => [],
          addMember: async () => {
            throw new Error('Project collaboration groups cannot add members')
          },
          updateMember: async () => {
            throw new Error('Project collaboration groups cannot update members')
          },
          removeMember: async () => undefined,
          async createCollaborationGroup(input) {
            requireActive()
            if (!api.projects.createCollaborationGroup) {
              throw new Error('Project collaboration group API is unavailable')
            }
            const created = await api.projects.createCollaborationGroup(projectId, input)
            await reloadAfterMutation()
            return created
          },
          async updateCollaborationGroup(groupId, input) {
            requireActive()
            const group = groups.find(candidate => candidate.id === groupId)
            if (!group) {
              throw new Error('Project collaboration group was not found')
            }
            let updated: CollaborationGroup | undefined
            if (group.owner_type === 'workspace') {
              if (!workspaceId || !api.workspaces?.updateCollaborationGroup) {
                throw new Error('Workspace collaboration group API is unavailable')
              }
              updated = await api.workspaces.updateCollaborationGroup(workspaceId, groupId, input)
            } else {
              updated = await api.projects.updateCollaborationGroup?.(projectId, groupId, input)
            }
            if (!updated) {
              throw new Error('Project collaboration group API is unavailable')
            }
            await reloadAfterMutation()
            return updated
          },
          async addCollaborationGroup(groupId) {
            requireActive()
            if (!api.projects.addCollaborationGroup) {
              throw new Error('Project collaboration group API is unavailable')
            }
            const added = await api.projects.addCollaborationGroup(projectId, groupId)
            await reloadAfterMutation()
            return added
          },
          async removeCollaborationGroup(groupId) {
            requireActive()
            if (!api.projects.removeCollaborationGroup) {
              throw new Error('Project collaboration group API is unavailable')
            }
            await api.projects.removeCollaborationGroup(projectId, groupId)
            await reloadAfterMutation()
          },
        }}
      />
    </>
  )
}

// Reset both directory state and editor drafts before a new identity is committed.
// The scoped component also invalidates pending reads and post-mutation reloads.
export function ProjectCollaborationGroups(
  props: Parameters<typeof ScopedProjectCollaborationGroups>[0]
) {
  const { api, projectId, workspaceId } = props
  const [scope, setScope] = useState({
    api,
    projectId,
    workspaceId,
    revision: 0,
  })
  if (scope.api !== api || scope.projectId !== projectId || scope.workspaceId !== workspaceId) {
    setScope({ api, projectId, workspaceId, revision: scope.revision + 1 })
  }
  return <ScopedProjectCollaborationGroups key={scope.revision} {...props} />
}
