// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { CollaborationGroup } from '@wegent/collaboration'
import type { ChatGroup } from '@/api/chatGroups'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  type CloudLoopItem,
  type CloudProject,
} from '@/api/deliveries'
import type { LocalProjectChatAgent, LocalTaskAgentResources } from './localDelivery'
import { loadLocalAssignmentContext, localAssignmentAgent } from './localAssignmentContext'
import '@/i18n'

const agent = (id: string, projectId: string) =>
  ({ id, projectId, status: 'active' }) as LocalProjectChatAgent
function setup() {
  const task = {
    id: 'thread',
    cloud_project_id: 'group',
    group_id: 'group',
    permissions: { edit_content: true, assign: true, comment: true, execute: true },
  } as CloudLoopItem
  const group = { id: 'group', status: 'active', name: 'Group', configuration: {} } as ChatGroup
  const project = { id: 'project', status: 'active', project_store: 'local' } as CloudProject
  const resolved: LocalTaskAgentResources = {
    workOwnerId: 'group',
    resourceOwnerId: 'group',
    agents: [agent('group-agent', 'group')],
    references: { 'group-agent': 'group-agent' },
    collaborationGroup: null,
  }
  const ports = {
    getTask: vi.fn(async () => task),
    listProjects: vi.fn(async () => ({ items: [project] })),
    groups: { get: vi.fn(async () => ({ group, members: [] })) },
    resolveResources: vi.fn(async () => resolved),
  }
  const input = {
    projectId: 'group',
    itemId: 'thread',
    assigneeType: 'agent' as const,
    assigneeId: 'group-agent',
  }
  return { ports, task, group, project, resolved, input }
}

describe('Native-authorized local assignment context', () => {
  it('uses a group agent without querying any project', async () => {
    const { ports, input } = setup()
    ports.listProjects.mockRejectedValue(new Error('Project unavailable'))
    const result = await loadLocalAssignmentContext(input, ports)
    expect(result.work.id).toBe('group')
    expect(result.resource.id).toBe('group')
    expect(ports.listProjects).not.toHaveBeenCalled()
    expect(ports.resolveResources).toHaveBeenCalledWith(input)
  })

  it('keeps the actual work owner when Native authorizes linked project resources', async () => {
    const { ports, resolved, input } = setup()
    resolved.resourceOwnerId = 'project'
    resolved.agents = [agent('project-agent', 'project')]
    resolved.references = { 'project-agent': 'project-agent' }
    const result = await loadLocalAssignmentContext(
      { ...input, assigneeId: 'project-agent' },
      ports
    )
    expect(result.work.id).toBe('group')
    expect(result.resource.id).toBe('project')
  })

  it('prepares only the exact Native-authorized retained installation from a completed migration', async () => {
    const { ports, resolved, input } = setup()
    resolved.resourceOwnerId = 'project'
    resolved.agents = [agent('retained', DEFAULT_WORK_ITEM_PROJECT_ID)]
    resolved.references = { retained: 'retained' }
    const result = await loadLocalAssignmentContext({ ...input, assigneeId: 'retained' }, ports)
    expect(result.resource.id).toBe('project')
    expect(localAssignmentAgent(result, 'retained')?.projectId).toBe(DEFAULT_WORK_ITEM_PROJECT_ID)
    expect(localAssignmentAgent(result, 'unrelated')).toBeUndefined()
  })

  it('propagates authority denial instead of probing global or alternate owners', async () => {
    const { ports, input } = setup()
    ports.resolveResources.mockRejectedValue(new Error('Unrelated installation is not authorized'))
    await expect(
      loadLocalAssignmentContext({ ...input, assigneeId: 'unrelated' }, ports)
    ).rejects.toThrow('not authorized')
    expect(ports.listProjects).not.toHaveBeenCalled()
  })

  it('preserves the raw crew ID and explicit source, and resolves legacy references to canonical bindings', async () => {
    const { ports, resolved, input } = setup()
    resolved.resourceOwnerId = 'project'
    resolved.collaborationGroup = { id: 'same', binding_owner_id: 'project' } as CollaborationGroup
    resolved.agents = [agent('binding', DEFAULT_WORK_ITEM_PROJECT_ID)]
    resolved.references = { 'team-alias': 'binding' }
    const request = {
      ...input,
      assigneeType: 'group' as const,
      assigneeId: 'same',
      assigneeGroupSourceId: 'project',
    }
    const result = await loadLocalAssignmentContext(request, ports)
    expect(ports.resolveResources).toHaveBeenCalledWith(request)
    expect(result.crew?.id).toBe('same')
    expect(localAssignmentAgent(result, 'team-alias')?.id).toBe('binding')
  })

  it.each(['membership', 'ownership', 'archived'] as const)(
    'rejects a stale %s before preparing resources',
    async reason => {
      const { ports, task, group, input } = setup()
      if (reason === 'membership') task.permissions = { ...task.permissions!, execute: false }
      if (reason === 'ownership') task.cloud_project_id = 'other'
      if (reason === 'archived') group.status = 'archived'
      await expect(loadLocalAssignmentContext(input, ports)).rejects.toThrow()
      expect(ports.resolveResources).not.toHaveBeenCalled()
    }
  )

  it('rejects a Native resolution for another work owner', async () => {
    const { ports, resolved, input } = setup()
    resolved.workOwnerId = 'other'
    await expect(loadLocalAssignmentContext(input, ports)).rejects.toThrow()
  })

  it('retains the original project route while delegating legacy resource authority to Native', async () => {
    const { ports, task, resolved, input } = setup()
    task.group_id = null
    task.cloud_project_id = 'project'
    resolved.workOwnerId = 'project'
    resolved.resourceOwnerId = 'project'
    const result = await loadLocalAssignmentContext({ ...input, projectId: 'project' }, ports)
    expect(result.work.id).toBe('project')
    expect(ports.groups.get).not.toHaveBeenCalled()
  })
})
