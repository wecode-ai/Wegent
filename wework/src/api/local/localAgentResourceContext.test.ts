// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import { groupWorkContainer } from '@/api/groupWorkContainer'
import { createLocalProjectChatAgentApi } from './localDelivery'
import { localAgentResourceContext } from './localAgentResourceContext'
import '@/i18n'

const group = groupWorkContainer(
  {
    id: 'group',
    project_key: 'G',
    name: 'Group',
    description: '',
    status: 'active',
    version: 1,
    role: 'Owner',
    created_by_user_id: 0,
    created_at: '',
    updated_at: '',
    configuration: {},
  },
  'local'
)

describe('group Agent model preview context', () => {
  it('uses the known group for both model previews without a project directory', async () => {
    const environments = vi.fn(async (_id?: string, known?: CloudProject) => {
      if (!known) throw new Error('Unrelated project directory is unavailable')
      return [
        {
          id: 'device',
          device_key: 'device',
          name: 'Device',
          owner_type: 'user' as const,
          owner_id: '0',
          status: 'online' as const,
          project_authorized: false,
          models: [],
          runtimes: [],
        },
      ]
    })
    const request = vi.fn()
    const api = createLocalProjectChatAgentApi(request, 0, environments, undefined, environments)
    await expect(api.listRunnerEnvironments('group')).rejects.toThrow('project directory')
    const scoped = localAgentResourceContext(api, group)
    await expect(scoped.listRunnerEnvironments('group')).resolves.toHaveLength(1)
    await expect(scoped.listEnvironments('group')).resolves.toHaveLength(1)
    expect(environments.mock.calls.slice(1)).toEqual([
      ['group', group],
      ['group', group],
    ])
    expect(request).not.toHaveBeenCalled()
  })

  it('does not apply group configuration to a foreign project preview', async () => {
    const environments = vi.fn().mockResolvedValue([])
    const api = createLocalProjectChatAgentApi(vi.fn(), 0, environments, undefined, environments)
    await localAgentResourceContext(api, group).listRunnerEnvironments('other-project')
    expect(environments).toHaveBeenCalledExactlyOnceWith('other-project')
  })
})
