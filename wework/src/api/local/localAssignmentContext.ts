import type { CollaborationGroup } from '@wegent/collaboration'
import type { ChatGroupApi } from '@/api/chatGroups'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { groupWorkContainer } from '@/api/groupWorkContainer'
import i18n from '@/i18n'
import type {
  LocalAssignmentExecutionPayloadInput,
  LocalProjectChatAgent,
  LocalTaskAgentResources,
} from './localDelivery'

interface Ports {
  getTask(id: string): Promise<CloudLoopItem>
  listProjects(): Promise<{ items: CloudProject[] }>
  groups: Pick<ChatGroupApi, 'get'>
  resolveResources(input: LocalAssignmentExecutionPayloadInput): Promise<LocalTaskAgentResources>
}

export interface LocalAssignmentContext {
  task: CloudLoopItem
  work: CloudProject
  resource: CloudProject
  agents: LocalProjectChatAgent[]
  references: Record<string, string>
  crew?: CollaborationGroup
}

function unavailable(
  key:
    | 'executionContextUnavailable'
    | 'executionResourceUnavailable'
    | 'executionParticipationRequired'
): never {
  throw new Error(i18n.t(`collaboration:${key}`))
}

async function project(ports: Ports, id: string) {
  const value = (await ports.listProjects()).items.find(candidate => String(candidate.id) === id)
  if (!value || value.status !== 'active' || value.project_store !== 'local')
    unavailable('executionResourceUnavailable')
  return value
}

/** The Native resolver owns authority, migration provenance, aliases and crew source selection. */
export async function loadLocalAssignmentContext(
  input: LocalAssignmentExecutionPayloadInput,
  ports: Ports
): Promise<LocalAssignmentContext> {
  const workId = String(input.projectId)
  const task = await ports.getTask(input.itemId)
  if (String(task.cloud_project_id) !== workId || (task.group_id && task.group_id !== workId))
    unavailable('executionContextUnavailable')
  if (task.group_id && task.permissions?.execute !== true)
    unavailable('executionParticipationRequired')
  const work = task.group_id
    ? groupWorkContainer((await ports.groups.get(workId)).group, 'local')
    : await project(ports, workId)
  if (work.status !== 'active') unavailable('executionContextUnavailable')
  const resolved = await ports.resolveResources(input)
  if (resolved.workOwnerId !== workId) unavailable('executionContextUnavailable')
  const resource =
    resolved.resourceOwnerId === workId ? work : await project(ports, resolved.resourceOwnerId)
  if (
    input.assigneeType === 'group' &&
    (!resolved.collaborationGroup || resolved.collaborationGroup.id !== input.assigneeId)
  )
    unavailable('executionResourceUnavailable')
  if (
    Object.values(resolved.references).some(
      id => !resolved.agents.some(agent => agent.id === id && agent.status === 'active')
    )
  )
    unavailable('executionResourceUnavailable')
  return {
    task,
    work,
    resource,
    agents: resolved.agents,
    references: resolved.references,
    crew: resolved.collaborationGroup ?? undefined,
  }
}

export function localAssignmentAgent(
  context: Pick<LocalAssignmentContext, 'agents' | 'references'>,
  reference: string
) {
  const id = context.references[reference]
  return context.agents.find(agent => agent.id === id && agent.status === 'active')
}
