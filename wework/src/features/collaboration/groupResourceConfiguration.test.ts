// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceAutomationInput } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { localGroupCrews } from './localGroupCrews'
import { localGroupAutomations } from './localGroupAutomations'
import { createGroupWorkspaceApi } from './groupWorkspaceApi'
import '@/i18n'

function fixture() {
  let group: ChatGroup = {
    id: 'group',
    project_key: 'G',
    name: 'Design',
    description: '',
    status: 'active',
    version: 4,
    role: 'Owner',
    created_by_user_id: 42,
    created_at: '',
    updated_at: '',
    configuration: {},
  }
  const get = vi.fn(async () => ({
    group,
    members: [{ user_id: 0, name: 'Me', role: 'Owner' as const }],
  }))
  const update = vi.fn(async (_id: string, input: Parameters<ChatGroupApi['update']>[1]) => {
    if (input.version !== group.version) throw new Error('Version conflict')
    group = {
      ...group,
      version: group.version + 1,
      configuration: { ...group.configuration, ...input.configuration },
    }
    return { group }
  })
  const groups = { get, update } as unknown as ChatGroupApi
  const changed = vi.fn()
  return { groups, get, update, changed }
}
const rule: WorkspaceAutomationInput = {
  name: 'New thread',
  prompt: 'Review',
  triggerType: 'event',
  eventType: 'task.created',
  eventConfig: {},
  cronExpression: null,
  timezone: 'Asia/Shanghai',
  executionDeviceId: null,
  targetKind: 'agent',
  targetId: 'agent',
  enabled: true,
}

describe('group resource configuration', () => {
  it('creates a native crew in the actual group with local principal and no workspace', async () => {
    const { groups, update, changed } = fixture()
    const port = localGroupCrews(groups, 'group', changed)
    const crew = await port.createCollaborationGroup('group', {
      name: 'Delivery',
      leader: { kind: 'human', id: '0' },
      members: [{ kind: 'human', id: '0' }],
    })
    expect(crew).toMatchObject({
      workspace_id: null,
      owner_type: 'chat_group',
      owner_id: 'group',
      binding_owner_id: 'group',
      created_by_user_id: 0,
    })
    expect(update).toHaveBeenCalledWith(
      'group',
      expect.objectContaining({ version: 4, configuration: { collaboration_groups: [crew] } })
    )
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('does not persist an invalid crew or overwrite a newer crew definition', async () => {
    const { groups, update, changed } = fixture()
    const port = localGroupCrews(groups, 'group', changed)
    await expect(
      port.createCollaborationGroup('group', {
        name: 'Invalid',
        leader: { kind: 'human', id: '0' },
        members: [],
      })
    ).rejects.toThrow('Leader must be a member')
    expect(update).not.toHaveBeenCalled()
    const crew = await port.createCollaborationGroup('group', {
      name: 'Valid',
      leader: { kind: 'human', id: '0' },
      members: [{ kind: 'human', id: '0' }],
    })
    await expect(
      port.updateCollaborationGroup('group', crew.id, { version: 0, name: 'Stale' })
    ).rejects.toThrow('changed')
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('preserves the configuration version read with automation rules instead of silently overwriting concurrent changes', async () => {
    const { groups, get, update, changed } = fixture()
    const base = {
      agents: { list: vi.fn().mockResolvedValue([{ id: 'agent', name: 'Reviewer' }]) },
    } as unknown as SharedWorkspaceApi
    const original = await get()
    get
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ ...original, group: { ...original.group, version: 5 } })
    update.mockRejectedValue(new Error('Version conflict'))
    await expect(
      localGroupAutomations(groups, 'group', base, changed).create('group', rule)
    ).rejects.toThrow('Version conflict')
    expect(update).toHaveBeenCalledWith('group', expect.objectContaining({ version: 4 }))
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps native metadata keys out of cloud group writes and preserves cloud primary automation and crew ports', async () => {
    const { groups, update, changed } = fixture()
    const crews = vi.fn()
    const automations = { create: vi.fn() }
    const base = {
      projects: { listCollaborationGroups: crews },
      issues: {},
      members: {},
      automations,
    } as unknown as SharedWorkspaceApi
    const cloud = createGroupWorkspaceApi(base, groups, 'group', 'cloud', changed)
    await cloud.projects.update('group', {
      version: 4,
      tags: ['review'],
      collaborationGroups: [],
      automaticProcessingRules: [],
    })
    expect(update).toHaveBeenCalledWith(
      'group',
      expect.objectContaining({ configuration: { tags: ['review'] } })
    )
    expect(cloud.automations).toBe(automations)
    expect(cloud.projects.listCollaborationGroups).toBe(crews)
  })
})
