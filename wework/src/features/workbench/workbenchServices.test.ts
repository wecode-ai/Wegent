import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const project = {
    id: 'cloud-1',
    public_id: 'public-1',
    project_key: 'CLOUD',
    name: 'Cloud GitLab',
    description: '',
    project_store: 'backend' as const,
    task_provider: 'gitlab' as const,
    provider_config: {
      repository: 'group/project',
      domain: 'gitlab.example.com',
      api_base: 'https://gitlab.example.com/api/v4',
    },
    created_by_user_id: 1,
    status: 'active',
    tags: [],
    version: 1,
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
  }
  const backendDeliveryApi = {
    listCloudProjects: vi.fn(async () => ({ items: [project] })),
    listLoopItems: vi.fn(),
    createLoopItem: vi.fn(async () => ({
      id: 'CLOUD-1',
      cloud_project_id: project.id,
      title: 'GitLab Issue',
    })),
  }
  const externalIssueApi = {
    configureProject: vi.fn(async () => undefined),
    retainProjects: vi.fn(async () => undefined),
    listLoopItems: vi.fn(async () => ({ items: [] })),
    createLoopItem: vi.fn(async () => ({
      id: 'CLOUD-1',
      cloud_project_id: project.id,
      title: 'GitLab Issue',
    })),
  }
  const localDeliveryApi = {}
  return {
    project,
    backendDeliveryApi,
    externalIssueApi,
    localDeliveryApi,
    backendServices: {
      deliveryApi: backendDeliveryApi,
      projectSpaceApis: {
        cloud: backendDeliveryApi,
        defaultLocation: 'cloud' as const,
      },
    },
    localServices: {
      deliveryApi: localDeliveryApi,
      externalIssueApi,
    },
  }
})

vi.mock('@/api/backend/backendServices', () => ({
  createBackendWorkbenchServices: vi.fn(() => mocks.backendServices),
}))

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: vi.fn(() => mocks.localServices),
}))

vi.mock('@/lib/runtime-mode', () => ({
  isLocalFirstAppRuntime: vi.fn(() => false),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: vi.fn(() => true),
}))

import { createDefaultWorkbenchServices } from './workbenchServices'

describe('default workbench project-space services', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('keeps cloud GitLab tasks on the backend in backend desktop mode', async () => {
    const services = createDefaultWorkbenchServices()
    const api = services.projectSpaceApis!.cloud!

    await api.listCloudProjects()
    await api.createLoopItem(mocks.project.id, {
      title: 'GitLab Issue',
      status: 'pending',
    })

    expect(mocks.externalIssueApi.retainProjects).not.toHaveBeenCalled()
    expect(mocks.backendDeliveryApi.listCloudProjects).toHaveBeenCalled()
    expect(mocks.backendDeliveryApi.createLoopItem).toHaveBeenCalledWith(mocks.project.id, {
      title: 'GitLab Issue',
      status: 'pending',
    })
    expect(mocks.externalIssueApi.configureProject).not.toHaveBeenCalled()
    expect(mocks.externalIssueApi.createLoopItem).not.toHaveBeenCalled()
    expect(services.projectSpaceApis?.local).toBe(mocks.localDeliveryApi)
  })
})
