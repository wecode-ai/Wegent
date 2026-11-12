// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { localGroupExecutionDevices } from './localGroupExecutionDevices'

function fixture(overrides: Partial<ChatGroup> = {}) {
  let group: ChatGroup = {
    id: 'group',
    project_key: 'G',
    name: 'Design',
    description: '',
    status: 'active',
    version: 4,
    role: 'Owner',
    created_by_user_id: 0,
    created_at: '',
    updated_at: '',
    ...overrides,
    configuration: { execution_environment: { repositories: [], setup_steps: [], devices: {} } },
  }
  const update = vi.fn(async (_id: string, input: Parameters<ChatGroupApi['update']>[1]) => {
    if (input.version !== group.version) throw new Error('Version conflict')
    group = {
      ...group,
      version: group.version + 1,
      configuration: { ...group.configuration, ...input.configuration },
    }
    return { group }
  })
  const groups = {
    get: vi.fn(async () => ({ group, members: [] })),
    update,
  } as unknown as ChatGroupApi
  const device = { id: 'device:private', device_id: 0, device_key: 'private', status: 'offline' }
  const local = vi.fn(async () => [device])
  const base = {
    resources: { devices: { local } },
    projects: { list: vi.fn() },
  } as unknown as SharedWorkspaceApi
  const changed = vi.fn()
  return {
    port: localGroupExecutionDevices(groups, 'group', base, changed),
    update,
    changed,
    device,
  }
}

describe('native Group execution device authorization', () => {
  it.each([
    { status: 'archived' as const },
    { role: 'Viewer' as const },
    { role: 'Developer' as const },
  ])(
    'does not mutate devices without current active administrator authority (%j)',
    async overrides => {
      const { port, update, changed } = fixture(overrides)
      await expect(port.addExecutionEnvironment('group', 0)).rejects.toThrow('administrator')
      await expect(port.removeExecutionEnvironment('group', 0)).rejects.toThrow('administrator')
      expect(update).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
    }
  )
  it('explicitly adds and revokes an offline private device without inventing preparation', async () => {
    const { port, update, changed, device } = fixture()
    expect(await port.listExecutionEnvironments('group')).toEqual([])
    expect(await port.addExecutionEnvironment('group', 0)).toEqual(device)
    expect(update.mock.calls[0][1].configuration?.execution_environment).toEqual({
      repositories: [],
      setup_steps: [],
      devices: { private: {} },
    })
    expect(await port.listExecutionEnvironments('group')).toEqual([device])
    await port.removeExecutionEnvironment('group', 0)
    expect(await port.listExecutionEnvironments('group')).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('rejects foreign containers and devices absent from the private device port', async () => {
    const { port, update, changed } = fixture()
    await expect(port.addExecutionEnvironment('project', 0)).rejects.toThrow('another Group')
    await expect(port.listExecutionEnvironments('project')).rejects.toThrow('another Group')
    await expect(port.addExecutionEnvironment('group', 7)).rejects.toThrow('unavailable')
    expect(update).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })
})
