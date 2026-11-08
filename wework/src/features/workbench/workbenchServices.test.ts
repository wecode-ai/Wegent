import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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
  const sharedWorkspaceApi = { projects: { list: vi.fn() } }
  return {
    project,
    backendDeliveryApi,
    externalIssueApi,
    localDeliveryApi,
    sharedWorkspaceApi,
    backendServices: {
      issueHumanRequestsApi: { inbox: vi.fn() },
      projectChatClient: { subscribe: vi.fn() },
      deliveryApi: backendDeliveryApi,
      sharedWorkspaceApi,
      projectSpaceApis: {
        cloud: backendDeliveryApi,
        defaultLocation: 'cloud' as const,
      },
    },
    localServices: {
      deliveryApi: localDeliveryApi,
      externalIssueApi,
      localParticipationIdentity: {
        nativeOwnerUserId: 0 as const,
        currentUser: { id: 7, user_name: 'current-user' },
        viewerUserIds: [0, 7],
      },
      localIssueHumanRequestsApi: { inbox: vi.fn() },
      localProjectChatClient: { subscribe: vi.fn() },
    },
    hybridServices: {
      deliveryApi: backendDeliveryApi,
      sharedWorkspaceApi,
      projectSpaceApis: {
        local: localDeliveryApi,
        cloud: backendDeliveryApi,
        defaultLocation: 'cloud' as const,
      },
    },
  }
})

vi.mock('@/api/backend/backendServices', () => ({
  createBackendWorkbenchServices: vi.fn(() => mocks.backendServices),
}))

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: vi.fn(() => mocks.localServices),
}))

vi.mock('@/api/hybrid/hybridServices', () => ({
  createHybridWorkbenchServices: vi.fn(() => mocks.hybridServices),
}))

vi.mock('@/lib/runtime-mode', () => ({
  isLocalFirstAppRuntime: vi.fn(() => false),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: vi.fn(() => true),
  isElectronRuntime: vi.fn(() => true),
}))

import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import { createDefaultWorkbenchServices } from './workbenchServices'

describe('default workbench project-space services', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isLocalFirstAppRuntime).mockReturnValue(false)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('preserves local participation scope alongside cloud-first desktop services', () => {
    const services = createDefaultWorkbenchServices()

    expect(services.localParticipationIdentity).toBe(mocks.localServices.localParticipationIdentity)
    expect(services.localIssueHumanRequestsApi).toBe(mocks.localServices.localIssueHumanRequestsApi)
    expect(services.localProjectChatClient).toBe(mocks.localServices.localProjectChatClient)
    expect(services.issueHumanRequestsApi).toBe(mocks.backendServices.issueHumanRequestsApi)
    expect(services.projectChatClient).toBe(mocks.backendServices.projectChatClient)
    expect(services.sharedWorkspaceApi).toBe(mocks.backendServices.sharedWorkspaceApi)
    expect(services.projectSpaceApis?.defaultLocation).toBe('cloud')
  })

  test('keeps local-first participation and chat owned by the local composition', () => {
    vi.mocked(isLocalFirstAppRuntime).mockReturnValue(true)

    const services = createDefaultWorkbenchServices()

    expect(services.localParticipationIdentity).toBe(mocks.localServices.localParticipationIdentity)
    expect(services.localIssueHumanRequestsApi).toBe(mocks.localServices.localIssueHumanRequestsApi)
    expect(services.localProjectChatClient).toBe(mocks.localServices.localProjectChatClient)
    expect(services.issueHumanRequestsApi).not.toBe(mocks.backendServices.issueHumanRequestsApi)
    expect(services.projectChatClient).not.toBe(mocks.backendServices.projectChatClient)
  })

  test('adds build-time feedback submission to an offline local workbench', () => {
    vi.mocked(isLocalFirstAppRuntime).mockReturnValue(true)
    vi.stubEnv('VITE_WEWORK_FEEDBACK_URL', 'https://feedback.example.com/v1/reports')

    const services = createDefaultWorkbenchServices()

    expect(services.feedbackApi).toBeDefined()
  })

  test('adds build-time feedback submission to a connected local workbench', () => {
    vi.mocked(isLocalFirstAppRuntime).mockReturnValue(true)
    vi.stubEnv('VITE_WEWORK_FEEDBACK_URL', 'https://feedback.example.com/v1/reports')

    const services = createDefaultWorkbenchServices({
      isConnected: true,
      backendUrl: 'https://backend.example.com',
      apiBaseUrl: 'https://backend.example.com/api',
      socketBaseUrl: 'https://backend.example.com',
      socketPath: '/socket.io',
      token: 'token',
      user: {
        id: 9,
        user_name: 'hongyu9',
        email: 'hongyu9@example.com',
      },
    })

    expect(services.feedbackApi).toBeDefined()
  })

  test('hides feedback submission in an unconfigured connected local workbench', () => {
    vi.mocked(isLocalFirstAppRuntime).mockReturnValue(true)
    vi.stubEnv('VITE_WEWORK_FEEDBACK_URL', '')

    const services = createDefaultWorkbenchServices({
      isConnected: true,
      backendUrl: 'https://backend.example.com',
      apiBaseUrl: 'https://backend.example.com/api',
      socketBaseUrl: 'https://backend.example.com',
      socketPath: '/socket.io',
      token: 'token',
      user: {
        id: 9,
        user_name: 'hongyu9',
        email: 'hongyu9@example.com',
      },
    })

    expect(services.feedbackApi).toBeUndefined()
  })

  test('rejects a connected cloud runtime without authenticated user identity', () => {
    vi.mocked(isLocalFirstAppRuntime).mockReturnValue(true)

    expect(() =>
      createDefaultWorkbenchServices({
        isConnected: true,
        backendUrl: 'https://backend.example.com',
        apiBaseUrl: 'https://backend.example.com/api',
        socketBaseUrl: 'https://backend.example.com',
        socketPath: '/socket.io',
        token: 'token',
      })
    ).toThrow('Connected cloud runtime configuration is incomplete')
  })
})
