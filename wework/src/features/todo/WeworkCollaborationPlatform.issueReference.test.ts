import { createScopedDraftStore } from '@/features/workbench/scopedDraftStore'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'

import { createPersonalHomeTaskDraftStore } from './personalHomeTaskDrafts'

import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'

import { clearRuntimeConversationCacheForTests } from '@/features/workbench/runtimeConversationCache'

import type {
  LocalProjectSpaceApi,
  ProjectSpaceDetailServices,
} from '@/features/workbench/workbenchServices'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { CollaborationPlatformLocation, SharedWorkspaceApi } from '@wegent/collaboration'

import { createElement } from 'react'

import { afterEach, expect, it, vi } from 'vitest'

import { createWeworkPlatformApi, WeworkCollaborationPlatform } from './WeworkCollaborationPlatform'

const renderedPlatformApis = vi.hoisted(() => new Map<string, SharedWorkspaceApi>())

vi.mock('@wegent/collaboration', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/collaboration')>()),
  CollaborationPlatformApp: ({
    api,
    host,
  }: {
    api: SharedWorkspaceApi
    host: { location: CollaborationPlatformLocation }
  }) => {
    if (host.location.projectId) renderedPlatformApis.set(host.location.projectId, api)
    return createElement('div', {
      'data-testid': 'collaboration-platform-root',
      'data-issue-id': host.location.issueId ?? '',
    })
  },
}))

afterEach(() => {
  vi.useRealTimers()
  clearRuntimeConversationCacheForTests()
  renderedPlatformApis.clear()
  localStorage.clear()
})

function createLocalDeliveryApi() {
  return {
    listCloudProjects: vi.fn().mockResolvedValue({
      items: [
        {
          id: DEFAULT_WORK_ITEM_PROJECT_ID,
          project_key: 'WORK',
          name: 'My Tasks',
          project_store: 'local',
          metadata: { system_kind: 'default_work_items' },
          collaboration_groups: [],
        },
        {
          id: 'local-project',
          name: 'Local project',
          project_store: 'local',
          metadata: { code_project_key: 'runtime-project' },
        },
      ],
    }),
    getBoardSnapshot: vi.fn().mockResolvedValue({
      items: [],
      task_bindings: [],
      members: [],
      agents: [],
    }),
    importLocalCodeProject: vi.fn().mockResolvedValue({
      id: 'local-project',
      name: 'Local project',
      project_store: 'local',
      metadata: {
        code_project_key: 'runtime-project',
        workspace_roots: ['/workspace/imported'],
      },
    }),
  } as unknown as LocalProjectSpaceApi
}

function createLocalDetailServices() {
  return {
    deviceApi: {
      listDevices: vi.fn().mockResolvedValue([
        {
          id: 7,
          device_id: 'local-device',
          name: 'Local device',
          device_type: 'local',
          status: 'online',
          capabilities: ['runtime-work', 'device-commands'],
        },
      ]),
    },
  } as unknown as ProjectSpaceDetailServices
}

function createHomeDraft() {
  return {
    draftStore: createScopedDraftStore(),
    setInputForScope: vi.fn(),
    personalHomeTaskDraftStore: createPersonalHomeTaskDraftStore(),
  }
}

it('opens a selected cloud Issue while the local runtime is unavailable', async () => {
  const localDeliveryApi = createLocalDeliveryApi()
  localDeliveryApi.getLoopItem = vi.fn().mockRejectedValue(new Error('Local runtime unavailable'))
  vi.mocked(localDeliveryApi.listCloudProjects).mockRejectedValue(
    new Error('Local runtime unavailable')
  )
  const project = { id: 'cloud-project', project_store: 'backend', name: 'Cloud project' }
  const issue = { id: 'cloud-issue', cloud_project_id: project.id, title: 'Unloaded cloud Issue' }
  const cloudGet = vi.fn().mockResolvedValue(project)
  const onActiveProjectChange = vi.fn()
  const cloudConnection: CloudConnectionContextValue = {
    ...DISCONNECTED_STATE,
    status: 'connected',
    isConnected: true,
    apiBaseUrl: 'https://cloud.example/api',
    token: 'synthetic-cloud-token',
    user: { id: 42, user_name: 'cloud-owner', email: '' },
    serviceKey: 'https://cloud.example/api:account:42',
    connectWithAuthorization: vi.fn(),
    refreshUser: vi.fn(),
    disconnect: vi.fn(),
  }
  render(
    createElement(
      CloudConnectionContext.Provider,
      { value: cloudConnection },
      createElement(WeworkCollaborationPlatform, {
        homeDraft: createHomeDraft(),
        user: { id: 1, user_name: 'local', email: '' } as never,
        localProjects: [],
        onActiveProjectChange,
        services: {
          projectSpaceApis: { local: localDeliveryApi },
          sharedWorkspaceApi: {
            workspaces: {},
            projects: { get: cloudGet },
            issues: { get: vi.fn().mockResolvedValue(issue) },
          },
        } as never,
      })
    )
  )
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  fireEvent.change(await screen.findByTestId('cloud-global-search-input'), {
    target: { value: 'CLOUD-1' },
  })
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Local runtime unavailable')
  fireEvent.click(screen.getByTestId('cloud-global-search-direct-backend:cloud-project'))
  await waitFor(() =>
    expect(onActiveProjectChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: project.id, location: 'cloud' })
    )
  )
  expect(screen.queryByTestId('cloud-global-search')).not.toBeInTheDocument()
  expect(screen.getByTestId('collaboration-platform-root')).toHaveAttribute(
    'data-issue-id',
    issue.id
  )
  await expect(renderedPlatformApis.get(project.id)!.projects.get(project.id)).resolves.toEqual(
    project
  )
  expect(localDeliveryApi.listCloudProjects).not.toHaveBeenCalled()
})

it('loads a source-qualified cloud project without consulting the local runtime', async () => {
  const localList = vi.fn().mockRejectedValue(new Error('Local runtime unavailable'))
  const cloudProject = { id: 'cloud-project', project_store: 'backend', name: 'Cloud project' }
  const cloudGet = vi.fn().mockResolvedValue(cloudProject)
  const api = createWeworkPlatformApi(
    { workspaces: {}, projects: { get: cloudGet } } as unknown as SharedWorkspaceApi,
    { projects: { list: localList } } as unknown as SharedWorkspaceApi,
    projectId => (projectId === 'cloud-project' ? 'cloud' : undefined)
  )
  await expect(api!.projects.get('cloud-project')).resolves.toEqual(cloudProject)
  expect(localList).not.toHaveBeenCalled()
  expect(cloudGet).toHaveBeenCalledWith('cloud-project')
})

it('closes the reference search after navigating to a directly resolved local Issue', async () => {
  const localDeliveryApi = createLocalDeliveryApi()
  localDeliveryApi.getLoopItem = vi.fn().mockResolvedValue({
    id: 'LOCAL-1',
    cloud_project_id: 'local-project',
    sequence_number: 1,
    title: 'Unloaded Issue',
    version: 1,
  })
  render(
    createElement(WeworkCollaborationPlatform, {
      homeDraft: createHomeDraft(),
      user: { id: 1, user_name: 'local', email: 'local@example.com' } as never,
      localProjects: [],
      services: {
        projectSpaceApis: { local: localDeliveryApi },
        projectSpaceDetailServices: { local: createLocalDetailServices() },
      } as never,
    })
  )
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  fireEvent.change(await screen.findByTestId('cloud-global-search-input'), {
    target: { value: 'LOCAL-1' },
  })
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  await waitFor(() => expect(localDeliveryApi.getLoopItem).toHaveBeenCalledWith('LOCAL-1'))
  await waitFor(() => expect(screen.queryByTestId('cloud-global-search')).not.toBeInTheDocument())
})
