import { describe, expect, test, vi } from 'vitest'
import type { DeliveryApi, ExternalIssueApi } from '@/features/workbench/workbenchServices'
import { createCloudProjectSpaceApi } from './cloudProjectSpaceApi'

describe('cloud project-space API', () => {
  test('routes every backend-owned project operation directly to Backend', async () => {
    const storeApi = {
      listCloudProjects: vi.fn(async () => ({ items: [] })),
      listLoopItems: vi.fn(async () => ({ items: [] })),
      createLoopItem: vi.fn(async () => ({ id: 'CLOUD-1' })),
    } as unknown as DeliveryApi
    const externalIssueApi = {
      retainProjects: vi.fn(async () => {
        throw new Error('local executor unavailable')
      }),
      configureProject: vi.fn(),
      listLoopItems: vi.fn(),
      createLoopItem: vi.fn(),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi)

    await api.listCloudProjects()
    await api.listLoopItems('cloud-1')
    await api.createLoopItem('cloud-1', { title: 'Backend routed' })

    expect(storeApi.listCloudProjects).toHaveBeenCalled()
    expect(externalIssueApi.retainProjects).not.toHaveBeenCalled()
    expect(storeApi.listLoopItems).toHaveBeenCalledWith('cloud-1')
    expect(storeApi.createLoopItem).toHaveBeenCalledWith('cloud-1', {
      title: 'Backend routed',
    })
    expect(externalIssueApi.configureProject).not.toHaveBeenCalled()
    expect(externalIssueApi.listLoopItems).not.toHaveBeenCalled()
    expect(externalIssueApi.createLoopItem).not.toHaveBeenCalled()
  })
})
