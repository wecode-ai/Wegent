// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SharedWorkspaceApi, WorkspaceProjectAgent } from '../ports/SharedWorkspaceApi'
import type { CollaborationOwnedAgent } from '../types'

function workspaceAgentRecord(agent: CollaborationOwnedAgent): WorkspaceProjectAgent {
  const teamId = agent.team_id
  if (teamId == null) {
    return {
      ...agent,
      id: agent.id,
      runtime: agent.runtime ?? 'codex',
      status: agent.status === 'unavailable' ? 'archived' : 'active',
      version: agent.version ?? 1,
    }
  }
  return {
    ...agent,
    id: String(teamId),
    runtime: 'wegent',
    status: 'active',
    version: 1,
    wegentTeamId: teamId,
  }
}

export function createWorkspaceAgentConfigurationApi(
  api: SharedWorkspaceApi,
  workspaceId: string
): SharedWorkspaceApi {
  const workspaces = api.workspaces
  if (!workspaces) return api
  return {
    ...api,
    agents: {
      async remove() {
        throw new Error('Project Agent deletion is unavailable in workspace scope')
      },
      async list() {
        return (await workspaces.listAgents(workspaceId)).map(workspaceAgentRecord)
      },
      async create(_scopeId, input) {
        const teamId = Number(input.wegentTeamId)
        if (!Number.isFinite(teamId)) {
          throw new Error('Workspace Agent is missing wegentTeamId')
        }
        return workspaceAgentRecord(await workspaces.addAgent(workspaceId, { teamId }))
      },
      async update(_scopeId, agentId) {
        const teamId = Number(agentId)
        const current = (await workspaces.listAgents(workspaceId)).find(
          agent => (Number.isFinite(teamId) && agent.team_id === teamId) || agent.id === agentId
        )
        if (!current) throw new Error('Workspace Agent was not found')
        if (current.team_id != null) {
          await workspaces.removeAgent(workspaceId, current.team_id)
        } else if (api.resources?.removeAgent) {
          await api.resources.removeAgent(current)
        } else {
          throw new Error('Workspace Agent cannot be removed')
        }
        return {
          ...workspaceAgentRecord(current),
          status: 'archived',
        }
      },
    },
  }
}
