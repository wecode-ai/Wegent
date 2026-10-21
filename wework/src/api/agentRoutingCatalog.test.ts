import { describe, expect, it, vi } from 'vitest'
import { createAgentRoutingCatalog } from './agentRoutingCatalog'
import type { HttpClient } from './http'
import type { RunnerEnvironment } from '@wegent/collaboration'

const runner: RunnerEnvironment = {
  id: '42',
  device_key: 'device-42',
  name: 'Runner',
  owner_type: 'user',
  owner_id: '1',
  status: 'online',
  project_authorized: false,
  runtimes: ['codex'],
  models: [],
}

function setup(deviceType = 'remote') {
  let scope = 1
  const get = vi.fn(async (path: string) => {
    if (path === '/devices')
      return {
        items: [
          {
            id: 42,
            device_id: 'device-42',
            device_type: deviceType,
            name: 'Runner',
            status: 'online',
            bind_shell: 'claudecode',
          },
        ],
      }
    if (path === '/v1/workspaces') return { items: [] }
    if (path.startsWith('/v1/resources/execution-environments')) return [runner]
    return { items: [] }
  })
  const read = vi.fn(async () => ({ models: [], errors: [] }))
  const api = createAgentRoutingCatalog(
    { get, getCacheScope: () => scope } as unknown as HttpClient,
    read
  )
  return {
    api,
    get,
    read,
    switchAccount: () => {
      scope += 1
    },
  }
}

describe('agent routing catalogs', () => {
  it('loads metadata without model RPCs and caches only the selected native catalog', async () => {
    const { api, get, read, switchAccount } = setup()
    const [first, second] = await Promise.all([
      api.listEnvironments('1'),
      api.listEnvironments('1'),
    ])
    expect(first).toEqual(second)
    expect(first[0].models).toEqual([])
    expect(read).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/resources/execution-environments')
    )
    await Promise.all([api.listNativeModels(first[0], '1'), api.listNativeModels(first[0], '1')])
    await api.listNativeModels(first[0], '1')
    expect(read).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith('device-42')
    switchAccount()
    await api.listEnvironments('1')
    await api.listNativeModels(first[0], '1')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('uses existing APP catalog authorization only after the APP device is selected', async () => {
    const { api, get, read } = setup('app')
    const rows = await api.listEnvironments()
    expect(read).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalledWith('/v1/resources/execution-environments')
    await api.listNativeModels(rows[0])
    expect(get).toHaveBeenCalledWith('/v1/resources/execution-environments')
    expect(read).not.toHaveBeenCalled()
  })

  it('retries native failures without poisoning the cache', async () => {
    const { api, read } = setup()
    const rows = await api.listEnvironments()
    read.mockRejectedValueOnce(new Error('connection lost'))
    await expect(api.listNativeModels(rows[0])).rejects.toThrow('connection lost')
    await expect(api.listNativeModels(rows[0])).resolves.toEqual({
      models: [],
      catalog_error: null,
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not mark an unusable project environment as authorized through its personal entry', async () => {
    const { api, get } = setup()
    const original = get.getMockImplementation()!
    get.mockImplementation(async path =>
      path.includes('/cloud-projects/')
        ? {
            items: [
              {
                ...runner,
                device_id: 42,
                kind: 'cloud_host',
                coding_tools: ['codex'],
                updated_at: '',
                owner_name: 'User',
                can_use: false,
              },
            ],
          }
        : original(path)
    )
    const rows = await api.listEnvironments('1')
    expect(rows.find(row => row.id === '42')?.project_authorized).toBe(false)
  })
})
