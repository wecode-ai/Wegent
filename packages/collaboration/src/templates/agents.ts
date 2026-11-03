// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import type { CollaborationAgent } from '../types'
import type { TemplateAgent, CollaborationTemplate, TemplateRoleAssignments } from './types'
import { PartialTemplateApplyError } from './apply'

const prefix = 'template-agent:'
export const templateAgentId = (key: string) => `${prefix}${key}`

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
  createAgent?: (agent: TemplateAgent) => Promise<CollaborationAgent>
): Promise<{
  drafts: ProjectCreateCollaborationGroupDraft[]
  agentIds: Set<string>
}> {
  const referenced = templateAgentReferences(drafts)
  const bindings = new Map<string, string>()
  try {
    for (const agent of document.spec.resources.collaboration.agents ?? []) {
      const id = templateAgentId(agent.key)
      if (!referenced.has(id)) continue
      const { key: _, ...configuration } = agent
      const created = createAgent
        ? await createAgent(agent)
        : await api.agents.create(projectId, {
            ...configuration,
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
