import { describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { DeliveryApi, ExternalIssueApi } from '@/features/workbench/workbenchServices'
import { createCloudProjectSpaceApi } from './cloudProjectSpaceApi'

const project: CloudProject = {
  id: 'cloud-1',
  public_id: 'public-1',
  project_key: 'CLOUD',
  name: 'Cloud GitHub board',
  description: '',
  project_store: 'backend',
  task_provider: 'github',
  provider_config: { repository: 'acme/repo' },
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-07-27T00:00:00Z',
  updated_at: '2026-07-27T00:00:00Z',
}

describe('cloud project-space API', () => {
  test('stores the token in backend and configures the local executor', async () => {
    const storeApi = {
      createCloudProject: vi.fn(async () => project),
    } as unknown as DeliveryApi
    const externalIssueApi = {
      configureProject: vi.fn(async () => undefined),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi, externalIssueApi)

    await api.createCloudProject({
      name: project.name,
      task_provider: 'github',
      provider_config: {
        repository: 'acme/repo',
        token: 'local-secret',
      },
    })

    expect(storeApi.createCloudProject).toHaveBeenCalledWith({
      name: project.name,
      task_provider: 'github',
      provider_config: {
        repository: 'acme/repo',
        token: 'local-secret',
      },
    })
    expect(externalIssueApi.configureProject).toHaveBeenCalledWith(project, 'local-secret')
  })

  test('uses submitted provider routing without waiting for the backend response to echo it', async () => {
    const incompatibleProject = {
      ...project,
      task_provider: 'local' as const,
      provider_config: {},
    }
    const storeApi = {
      createCloudProject: vi.fn(async () => incompatibleProject),
    } as unknown as DeliveryApi
    const externalIssueApi = {
      configureProject: vi.fn(),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi, externalIssueApi)

    const created = await api.createCloudProject({
      name: project.name,
      task_provider: 'github',
      provider_config: {
        repository: 'acme/repo',
        token: 'local-secret',
      },
    })

    expect(created.task_provider).toBe('github')
    expect(created.provider_config).toEqual({ repository: 'acme/repo' })
    expect(externalIssueApi.configureProject).toHaveBeenCalledWith(
      {
        ...incompatibleProject,
        project_store: 'backend',
        task_provider: 'github',
        provider_config: { repository: 'acme/repo' },
      },
      'local-secret'
    )
  })

  test('stores the project in backend and routes GitHub Issues through local executor', async () => {
    const storeApi = {
      listCloudProjects: vi.fn(async () => ({ items: [project] })),
      getCloudProjectProviderCredential: vi.fn(async () => ({ token: 'cloud-secret' })),
      createCloudProject: vi.fn(async () => project),
      listLoopItems: vi.fn(),
    } as unknown as DeliveryApi
    const issue = {
      id: 'CLOUD-7',
      cloud_project_id: project.id,
      title: 'Issue',
    }
    const externalIssueApi = {
      configureProject: vi.fn(async () => undefined),
      listLoopItems: vi.fn(async () => ({ items: [issue] })),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi, externalIssueApi)

    await api.listCloudProjects()
    const result = await api.listLoopItems(project.id)
    const [deliveries, bindings, attachments, collaborators] = await Promise.all([
      api.listDeliveries(issue.id),
      api.listTaskBindings(issue.id),
      api.listLoopItemAttachments(issue.id),
      api.listLoopItemCollaborators(issue.id),
    ])

    expect(result.items).toEqual([issue])
    expect(deliveries.items).toEqual([])
    expect(bindings).toEqual([])
    expect(attachments).toEqual([])
    expect(collaborators).toEqual([])
    expect(externalIssueApi.configureProject).toHaveBeenCalledWith(project, 'cloud-secret')
    expect(externalIssueApi.listLoopItems).toHaveBeenCalledWith(project)
    expect(storeApi.listLoopItems).not.toHaveBeenCalled()
  })

  test('creates cloud external tasks through the local Issue provider', async () => {
    const storeApi = {
      listCloudProjects: vi.fn(async () => ({ items: [project] })),
      getCloudProjectProviderCredential: vi.fn(async () => ({ token: 'cloud-secret' })),
      createLoopItem: vi.fn(),
    } as unknown as DeliveryApi
    const createdIssue = {
      id: 'CLOUD-8',
      cloud_project_id: project.id,
      title: 'Created in GitHub',
    }
    const externalIssueApi = {
      configureProject: vi.fn(async () => undefined),
      createLoopItem: vi.fn(async () => createdIssue),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi, externalIssueApi)

    await api.listCloudProjects()
    const result = await api.createLoopItem(project.id, {
      title: createdIssue.title,
      status: 'pending',
    })

    expect(result).toEqual(createdIssue)
    expect(externalIssueApi.createLoopItem).toHaveBeenCalledWith(project, {
      title: createdIssue.title,
      status: 'pending',
    })
    expect(storeApi.createLoopItem).not.toHaveBeenCalled()
  })

  test('blocks public visitors from opening or editing external tasks created by others', async () => {
    const publicProject = {
      ...project,
      visibility: 'public' as const,
      access_role: 'RestrictedAnalyst' as const,
      current_user_id: 2,
    }
    const otherUsersIssue = {
      id: 'CLOUD-9',
      cloud_project_id: project.id,
      title: 'Created by another user',
      can_view_detail: false,
      can_edit: false,
    }
    const ownedIssue = {
      id: 'CLOUD-10',
      cloud_project_id: project.id,
      title: 'Created by the visitor',
      can_view_detail: true,
      can_edit: true,
    }
    const storeApi = {
      listCloudProjects: vi.fn(async () => ({ items: [publicProject] })),
      getCloudProjectProviderCredential: vi.fn(async () => ({ token: 'cloud-secret' })),
    } as unknown as DeliveryApi
    const externalIssueApi = {
      configureProject: vi.fn(async () => undefined),
      listLoopItems: vi.fn(async () => ({ items: [otherUsersIssue, ownedIssue] })),
      getLoopItem: vi.fn(async () => ownedIssue),
      updateLoopItem: vi.fn(async () => ownedIssue),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi, externalIssueApi)

    await api.listCloudProjects()
    await api.listLoopItems(publicProject.id)

    await expect(api.getLoopItem(otherUsersIssue.id)).rejects.toThrow(
      'You can only view tasks that you created in this public project'
    )
    await expect(
      api.updateLoopItem(otherUsersIssue.id, {
        version: 1,
        title: 'Forbidden update',
      })
    ).rejects.toThrow('You can only edit tasks that you created in this public project')

    await expect(api.getLoopItem(ownedIssue.id)).resolves.toEqual(ownedIssue)
    await expect(
      api.updateLoopItem(ownedIssue.id, {
        version: 1,
        title: 'Allowed update',
      })
    ).resolves.toEqual(ownedIssue)
    expect(externalIssueApi.getLoopItem).toHaveBeenCalledTimes(1)
    expect(externalIssueApi.updateLoopItem).toHaveBeenCalledTimes(1)
  })

  test('updates backend credentials and refreshes the local executor configuration', async () => {
    const updatedProject = {
      ...project,
      provider_config: {
        repository: 'acme/repo',
        credential_configured: true,
      },
      version: 2,
    }
    const storeApi = {
      listCloudProjects: vi.fn(async () => ({ items: [project] })),
      getCloudProjectProviderCredential: vi.fn(async () => ({ token: 'rotated-secret' })),
      updateCloudProject: vi.fn(async () => updatedProject),
    } as unknown as DeliveryApi
    const externalIssueApi = {
      configureProject: vi.fn(async () => undefined),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi, externalIssueApi)

    await api.listCloudProjects()
    vi.clearAllMocks()
    const updated = await api.updateCloudProject(project.id, {
      version: 1,
      provider_config: {
        repository: 'acme/repo',
        token: 'rotated-secret',
      },
    })

    expect(updated).toEqual(updatedProject)
    expect(storeApi.updateCloudProject).toHaveBeenCalledWith(project.id, {
      version: 1,
      provider_config: {
        repository: 'acme/repo',
        token: 'rotated-secret',
      },
    })
    expect(externalIssueApi.configureProject).toHaveBeenCalledWith(updatedProject, 'rotated-secret')
  })

  test('keeps backend internal tasks on the backend store', async () => {
    const internalProject = { ...project, task_provider: 'local' as const }
    const storeApi = {
      listCloudProjects: vi.fn(async () => ({ items: [internalProject] })),
      listLoopItems: vi.fn(async () => ({ items: [] })),
    } as unknown as DeliveryApi
    const externalIssueApi = {
      configureProject: vi.fn(),
      listLoopItems: vi.fn(),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi, externalIssueApi)

    await api.listCloudProjects()
    await api.listLoopItems(internalProject.id)

    expect(storeApi.listLoopItems).toHaveBeenCalledWith(internalProject.id)
    expect(externalIssueApi.listLoopItems).not.toHaveBeenCalled()
  })

  test('loads an old external project without credentials so it can be repaired', async () => {
    const projectWithoutCredential = {
      ...project,
      provider_config: {
        repository: 'acme/repo',
        credential_configured: false,
      },
    }
    const storeApi = {
      listCloudProjects: vi.fn(async () => ({ items: [projectWithoutCredential] })),
      getCloudProjectProviderCredential: vi.fn(),
    } as unknown as DeliveryApi
    const externalIssueApi = {
      configureProject: vi.fn(),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi, externalIssueApi)

    await expect(api.listCloudProjects()).resolves.toEqual({
      items: [projectWithoutCredential],
    })
    expect(storeApi.getCloudProjectProviderCredential).not.toHaveBeenCalled()
    expect(externalIssueApi.configureProject).not.toHaveBeenCalled()
  })

  test('keeps cloud projects visible when one provider credential cannot be restored', async () => {
    const storeApi = {
      listCloudProjects: vi.fn(async () => ({ items: [project] })),
      getCloudProjectProviderCredential: vi.fn(async () => {
        throw new Error('Provider credential is not configured')
      }),
    } as unknown as DeliveryApi
    const externalIssueApi = {
      configureProject: vi.fn(),
    } as unknown as ExternalIssueApi
    const api = createCloudProjectSpaceApi(storeApi, externalIssueApi)

    await expect(api.listCloudProjects()).resolves.toEqual({ items: [project] })
    expect(externalIssueApi.configureProject).not.toHaveBeenCalled()
  })
})
