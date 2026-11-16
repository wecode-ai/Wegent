// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup } from '../types'
import type { CollaborationLocale } from '../i18n'
import type { TemplateRoutingResolver, CollaborationTemplate } from './types'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import { normalizeCollaborationGroupDraftForPersistence } from '../project-create/collaborationGroupDraft'
import { materializeTemplateAgents, templateAgentId, templateAgentReferences } from './agents'
import { applyTemplateGroups, TemplateConfigurationError } from './apply'
import { reconcileProjectTemplateFailure } from './projectApplyRecovery'

export async function prepareTemplateProject(
  api: SharedWorkspaceApi,
  projectId: string,
  document: CollaborationTemplate,
  locale: CollaborationLocale
) {
  const assignment = document.spec.resources.collaboration.project.taskAssignment
  if (!assignment) return
  if (!api.automations)
    throw new TemplateConfigurationError(
      locale === 'zh-CN'
        ? '当前项目不支持自动分配任务。'
        : 'Task routing is unavailable for this project.'
    )
  const existing = await api.automations.list(projectId)
  if (
    assignment.enabled &&
    existing.some(rule => rule.enabled && rule.eventType === 'task.created')
  ) {
    throw new TemplateConfigurationError(
      locale === 'zh-CN'
        ? '项目已有新任务自动处理规则，请先在项目设置中停用，再导入此模板。'
        : 'Disable the existing issue-created rule in project settings before importing this template.'
    )
  }
}

/** Resolve portable group references only after the new groups have been persisted. */
export async function configureTemplateProject(
  api: SharedWorkspaceApi,
  projectId: string,
  document: CollaborationTemplate,
  groups: CollaborationGroup[],
  locale: CollaborationLocale
) {
  const configuration = document.spec.resources.collaboration
  const { taskAssignment, board } = configuration.project
  if (taskAssignment) {
    const index = configuration.groups.findIndex(group => group.key === taskAssignment.groupKey)
    const group = groups[index]
    if (!group || !api.automations) throw new Error('template_group_unavailable')
    const agentIds = new Set(
      [group.leader, ...group.members, ...group.stages.map(stage => stage.assignee)]
        .filter(member => member?.kind === 'agent')
        .map(member => member!.id)
    )
    const agents = taskAssignment.enabled && agentIds.size ? await api.agents.list(projectId) : []
    const routingReady = [...agentIds].every(id => {
      const agent = agents.find(agent => agent.id === id || String(agent.team_id ?? '') === id)
      if (agent?.runtime === 'wegent') return true
      return (
        agent?.executionPolicy &&
        agent.executionPolicy.mode !== 'user_select' &&
        agent.modelPolicy?.mode === 'fixed'
      )
    })
    await api.automations.create(projectId, {
      name: locale === 'zh-CN' ? `新任务 → ${group.name}` : `New issues → ${group.name}`,
      prompt:
        group.instructions ||
        (locale === 'zh-CN'
          ? '由小组负责人协调分工、推进任务并核验交付。'
          : 'Coordinate the group, assign work and verify delivery.'),
      triggerType: 'event',
      eventType: 'task.created',
      eventConfig: {
        executionTarget: 'existing_issue',
        ...(taskAssignment.tags ? { tags: taskAssignment.tags } : {}),
        ...(taskAssignment.priorities ? { priorities: taskAssignment.priorities } : {}),
      },
      cronExpression: null,
      timezone: 'Asia/Shanghai',
      executionDeviceId: null,
      targetKind: 'collaboration_group',
      targetId: group.id,
      enabled: taskAssignment.enabled && routingReady,
    })
  }
  if (!board) return
  const latest = await api.projects.get(projectId)
  const id = crypto.randomUUID()
  await api.projects.update(projectId, {
    version: latest.version,
    tags: [...new Set([...latest.tags, ...board.tags])],
    ...(latest.board_config ? { boardConfig: { ...latest.board_config, group_by: 'tag' } } : {}),
    ...(latest.card_display ? { cardDisplay: { ...latest.card_display, show_tags: true } } : {}),
    boardViews: {
      schema_version: 1,
      default_view_id: id,
      views: [
        ...(latest.board_views?.views ?? []),
        {
          id,
          name: board.name,
          columns: [
            {
              id: crypto.randomUUID(),
              type: 'unmatched',
              value: locale === 'zh-CN' ? '待分派' : 'Backlog',
            },
            ...board.tags.map(tag => ({
              id: crypto.randomUUID(),
              type: 'tag' as const,
              value: tag,
            })),
          ],
          filter: { tags: [], match: 'all' },
        },
      ],
    },
  })
}

export async function applyProjectTemplate(
  api: SharedWorkspaceApi,
  projectId: string,
  document: CollaborationTemplate,
  drafts: ProjectCreateCollaborationGroupDraft[],
  locale: CollaborationLocale,
  partialMessage: string,
  resolveRouting?: TemplateRoutingResolver,
  onGroupsRefreshed?: (groups: CollaborationGroup[]) => void
) {
  if (!api.projects.createCollaborationGroup) throw new Error('template_group_unavailable')
  const references = templateAgentReferences(drafts)
  const agentNames = (document.spec.resources.collaboration.agents ?? [])
    .filter(agent => references.has(templateAgentId(agent.key)))
    .map(agent => agent.name)
  const recovery = {
    api,
    projectId,
    locale,
    groupNames: drafts.map(group => group.name.trim()),
    baselineGroups: undefined as CollaborationGroup[] | undefined,
    baselineAgentIds: undefined as Set<string> | undefined,
    agentNames,
    unconfirmedAgentCreation: false,
    mutationStarted: false,
    createdAgents: false,
    createdGroups: [] as CollaborationGroup[],
    onGroupsRefreshed,
  }
  try {
    recovery.baselineGroups = await api.projects.listCollaborationGroups?.(projectId)
    await prepareTemplateProject(api, projectId, document, locale)
    if (agentNames.length) {
      const agents = await api.agents.list(projectId, { forceRefresh: true })
      recovery.baselineAgentIds = new Set(agents.map(agent => String(agent.team_id ?? agent.id)))
    }
    const resolved = await materializeTemplateAgents(
      {
        agents: {
          ...api.agents,
          create: async (...args) => {
            recovery.mutationStarted = true
            recovery.unconfirmedAgentCreation = true
            const created = await api.agents.create(...args)
            recovery.createdAgents = true
            recovery.unconfirmedAgentCreation = false
            return created
          },
        },
      },
      projectId,
      document,
      drafts,
      partialMessage,
      undefined,
      resolveRouting
    )
    const groups = await applyTemplateGroups(
      resolved.drafts,
      async raw => {
        recovery.mutationStarted = true
        const created = await api.projects.createCollaborationGroup!(projectId, {
          ...normalizeCollaborationGroupDraftForPersistence(raw),
          coordinationMode: 'manager',
        })
        recovery.createdGroups.push(created)
        return created
      },
      partialMessage
    )
    await configureTemplateProject(api, projectId, document, groups, locale)
    return groups
  } catch (cause) {
    throw await reconcileProjectTemplateFailure(cause, recovery)
  }
}
