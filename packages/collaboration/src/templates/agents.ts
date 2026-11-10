// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import type { CollaborationAgent } from '../types'
import type {
  TemplateAgentRouting,
  TemplateRoutingResolver,
  TemplateAgent,
  CollaborationTemplate,
  TemplateRoleAssignments,
} from './types'
import { templateFailureMessage, templateMessages } from './messages'
import { PartialTemplateApplyError, TemplateConfigurationError } from './apply'

const prefix = 'template-agent:'
export const templateAgentId = (key: string) => `${prefix}${key}`

function referencedTemplateAgents(
  document: CollaborationTemplate,
  drafts: ProjectCreateCollaborationGroupDraft[]
): TemplateAgent[] {
  const referenced = templateAgentReferences(drafts)
  return (document.spec.resources.collaboration.agents ?? []).filter(agent =>
    referenced.has(templateAgentId(agent.key))
  )
}

export async function validateTemplateAgentRouting(
  document: CollaborationTemplate,
  drafts: ProjectCreateCollaborationGroupDraft[],
  resolveRouting: TemplateRoutingResolver
) {
  return new Map(
    await Promise.all(
      [...new Set(referencedTemplateAgents(document, drafts).map(agent => agent.runtime))].map(
        async runtime => [runtime, await resolveRouting(runtime)] as const
      )
    )
  )
}

export function templateAgentBindings(document: CollaborationTemplate): TemplateRoleAssignments {
  const agents = document.spec.resources.collaboration.agents ?? []
  return Object.fromEntries(
    document.spec.resources.collaboration.groups.map(group => [
      group.key,
      Object.fromEntries(
        group.roles.flatMap(role => {
          const agent = agents.find(agent => agent.key === role.agentKey)
          return agent
            ? [
                [
                  role.key,
                  {
                    kind: 'agent' as const,
                    id: templateAgentId(agent.key),
                    name: agent.name,
                    responsibility: '',
                  },
                ],
              ]
            : []
        })
      ),
    ])
  )
}

/** Create only referenced definitions; live identities are always owned by the destination. */
export async function materializeTemplateAgents(
  api: Pick<SharedWorkspaceApi, 'agents'>,
  projectId: string,
  document: CollaborationTemplate,
  drafts: ProjectCreateCollaborationGroupDraft[],
  partialMessage: string,
  createAgent?: (
    agent: TemplateAgent,
    routing: TemplateAgentRouting
  ) => Promise<CollaborationAgent>,
  resolveRouting: TemplateRoutingResolver = async () => {
    throw new TemplateConfigurationError('template_model_default_unavailable')
  }
): Promise<{
  drafts: ProjectCreateCollaborationGroupDraft[]
  agentIds: Set<string>
}> {
  const definitions = referencedTemplateAgents(document, drafts)
  const routings = await validateTemplateAgentRouting(document, drafts, resolveRouting)
  const bindings = new Map<string, string>()
  try {
    for (const agent of definitions) {
      const id = templateAgentId(agent.key)
      const { key: _, ...configuration } = agent
      const created = createAgent
        ? await createAgent(agent, routings.get(agent.runtime)!)
        : await api.agents.create(projectId, {
            ...configuration,
            ...routings.get(agent.runtime),
            capabilityMode: 'follow_device',
            executionEnvironment: 'local',
            executionMode: agent.executionMode ?? 'auto',
            workspacePolicy: agent.workspacePolicy ?? 'project',
          })
      bindings.set(id, String(created.team_id ?? created.id))
    }
  } catch (cause) {
    if (bindings.size) throw new PartialTemplateApplyError(partialMessage, { cause })
    throw cause
  }
  const bind = (member: ProjectCreateCollaborationGroupDraft['leader']) => {
    if (member.kind !== 'agent' || !member.id.startsWith(prefix)) return member
    const id = bindings.get(member.id)
    if (!id) throw new Error('template_agent_unavailable')
    return { ...member, id }
  }
  return {
    agentIds: new Set(bindings.values()),
    drafts: drafts.map(group => ({
      ...group,
      leader: bind(group.leader),
      members: group.members.map(bind),
      stages: group.stages.map(stage => ({
        ...stage,
        assignee: stage.assignee ? bind(stage.assignee) : null,
      })),
    })),
  }
}

/** Resolve full resource definitions only when the user saves or exports a template. */
export async function readTemplateAgents(
  agents: Array<CollaborationAgent & { wegentTeamId?: unknown }>,
  groups: import('../types').CollaborationGroup[],
  readResource?: import('../project-agent-config/types').ProjectAgentConfigurationHost['readTemplateAgent']
) {
  const used = new Set(
    groups
      .flatMap(group => [group.leader, ...group.members])
      .filter(member => member.kind === 'agent')
      .map(member => member.id)
  )
  if ([...used].some(id => !agents.some(agent => String(agent.team_id ?? agent.id) === id)))
    throw new Error('template_agent_definition_unavailable')
  return Promise.all(
    agents
      .filter(agent => used.has(String(agent.team_id ?? agent.id)))
      .map(async agent => {
        if (agent.runtime === 'codex' || agent.runtime === 'claude_code') return { ...agent }
        const teamId =
          agent.team_id ??
          (agent.runtime === 'wegent' ? Number(agent.wegentTeamId) : Number(agent.id))
        if (!readResource || !Number.isSafeInteger(teamId) || teamId <= 0)
          throw new Error('template_agent_definition_unavailable')
        return { ...agent, ...(await readResource(teamId)) }
      })
  )
}

export function templateAgentReferences(
  drafts: ProjectCreateCollaborationGroupDraft[]
): Set<string> {
  return new Set(
    drafts
      .flatMap(group => [
        group.leader,
        ...group.members,
        ...group.stages.flatMap(stage => (stage.assignee ? [stage.assignee] : [])),
      ])
      .filter(member => member.kind === 'agent')
      .map(member => member.id)
  )
}

export function templateRoutingResolver(
  host: import('../project-agent-config/types').ProjectAgentConfigurationHost | undefined,
  location: 'local' | 'cloud',
  projectId?: string,
  locale: 'zh-CN' | 'en' = 'en',
  environmentId?: string,
  models: Partial<
    Record<TemplateAgent['runtime'], import('../agent-form/runnerRouting').RunnerModelIdentity>
  > = {}
): TemplateRoutingResolver {
  return async runtime => {
    try {
      if (!host?.resolveTemplateAgentRouting) throw new Error('template_model_default_unavailable')
      const model = models[runtime]
      if (model !== undefined)
        return await host.resolveTemplateAgentRouting(
          runtime,
          location,
          projectId,
          environmentId,
          model
        )
      return await (environmentId === undefined
        ? host.resolveTemplateAgentRouting(runtime, location, projectId)
        : host.resolveTemplateAgentRouting(runtime, location, projectId, environmentId))
    } catch (cause) {
      if (
        cause instanceof Error &&
        [
          'template_model_default_unavailable',
          'template_model_unavailable',
          'template_environment_unavailable',
          'template_environment_ambiguous',
        ].includes(cause.message)
      )
        throw new TemplateConfigurationError(
          cause.message === 'template_environment_unavailable' && !projectId
            ? templateMessages[locale].destinationDeviceRequired
            : templateFailureMessage(cause, locale),
          { cause }
        )
      throw cause
    }
  }
}
