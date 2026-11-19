import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { TemplateParticipant } from './TemplateBindings'

export class TemplateProjectManagementRequiredError extends Error {}

export async function loadTemplateProjectContext(
  api: SharedWorkspaceApi,
  projectId: string,
  signal: AbortSignal
) {
  const project = await api.projects.get(projectId)
  signal.throwIfAborted()
  if (project.access_role !== 'Owner' && project.access_role !== 'Maintainer')
    throw new TemplateProjectManagementRequiredError()
  const [members, agents, groups] = await Promise.all([
    api.members.list(projectId),
    api.agents.list(projectId),
    api.projects.listCollaborationGroups?.(projectId) ?? Promise.resolve([]),
  ])
  const candidates: TemplateParticipant[] = [
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
  ]
  return { project, candidates, names: groups.map(group => group.name) }
}
