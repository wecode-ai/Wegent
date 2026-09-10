// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from 'vitest'
import type { CollaborationApi, CollaborationProject } from '@wegent/collaboration'

import type { CloudProject } from '@/api/deliveries'
import type { DeliveryApi, WorkbenchServices } from '@/features/workbench/workbenchServices'

import {
  collaborationIssueId,
  collaborationProjectReference,
  createWeworkCollaborationApi,
} from './weworkCollaborationApi'

const cloudProject: CollaborationProject = {
  id: 'cloud-1',
  public_id: 'cloud-public-1',
  project_key: 'CLOUD',
  name: 'Cloud project',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
}

const localProject: CloudProject = {
  ...cloudProject,
  id: 'local-1',
  public_id: 'local-public-1',
  project_key: 'LOCAL',
  name: 'Local project',
  project_store: 'local',
}

function cloudApi(): CollaborationApi {
  return {
    listProjects: vi.fn().mockResolvedValue([cloudProject]),
    getProject: vi.fn().mockResolvedValue(cloudProject),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    archiveProject: vi.fn(),
    getBoardSnapshot: vi.fn().mockResolvedValue({
      items: [
        {
          id: 'issue-1',
          cloud_project_id: 'cloud-1',
          sequence_number: 1,
          parent_id: null,
          created_by_user_id: 1,
          assignee_user_id: null,
          title: 'Shared issue',
          description: '',
          status: 'pending',
          priority: 'none',
          due_at: null,
          tags: [],
          sort_order: 0,
          version: 1,
          created_at: '2026-09-10T00:00:00Z',
          updated_at: '2026-09-10T00:00:00Z',
          completed_at: null,
        },
      ],
      members: [],
      agents: [],
    }),
    getIssue: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn().mockImplementation((id, data) => ({
      ...(id === 'issue-1'
        ? {
            id,
            cloud_project_id: 'cloud-1',
            sequence_number: 1,
            parent_id: null,
            created_by_user_id: 1,
            assignee_user_id: null,
            title: 'Shared issue',
            description: '',
            priority: 'none',
            due_at: null,
            tags: [],
            sort_order: 0,
            created_at: '2026-09-10T00:00:00Z',
            updated_at: '2026-09-10T00:00:00Z',
            completed_at: null,
          }
        : {}),
      ...data,
    })),
    reorderIssues: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(),
    listAttachments: vi.fn(),
    addAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    listMembers: vi.fn(),
    searchUsers: vi.fn(),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
    listAgents: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    listFiles: vi.fn(),
    createFolder: vi.fn(),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    listExecutions: vi.fn(),
    stopExecution: vi.fn(),
    listIncomingHooks: vi.fn(),
    createIncomingHook: vi.fn(),
    updateIncomingHook: vi.fn(),
    deleteIncomingHook: vi.fn(),
    listAutomations: vi.fn(),
    createAutomation: vi.fn(),
    updateAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    runAutomation: vi.fn(),
    listAutomationRuns: vi.fn(),
    cancelAutomationRun: vi.fn(),
    retryAutomationRun: vi.fn(),
  }
}

function services(api: CollaborationApi) {
  const localDeliveryApi = {
    listCloudProjects: vi.fn().mockResolvedValue({ items: [localProject] }),
    createCloudProject: vi.fn().mockResolvedValue(localProject),
  } as unknown as DeliveryApi
  return {
    collaborationApi: api,
    projectSpaceApis: {
      local: localDeliveryApi,
      defaultLocation: 'cloud',
    },
  } as unknown as WorkbenchServices
}

describe('createWeworkCollaborationApi', () => {
  test('presents cloud and local projects through the shared project home', async () => {
    const api = createWeworkCollaborationApi(services(cloudApi()))

    const projects = await api.listProjects()

    expect(projects.map(project => project.name)).toEqual(['Cloud project', 'Local project'])
    expect(projects.map(project => collaborationProjectReference(project.id))).toEqual([
      { location: 'cloud', projectId: 'cloud-1' },
      { location: 'local', projectId: 'local-1' },
    ])
  })

  test('keeps local creation as a host storage adaptation', async () => {
    const cloud = cloudApi()
    const workbenchServices = services(cloud)
    const api = createWeworkCollaborationApi(workbenchServices)

    const created = await api.createProject({
      name: 'Local project',
      project_store: 'local',
    })

    expect(workbenchServices.projectSpaceApis?.local?.createCloudProject).toHaveBeenCalledWith({
      name: 'Local project',
      description: undefined,
      task_provider: 'local',
    })
    expect(cloud.createProject).not.toHaveBeenCalled()
    expect(collaborationProjectReference(created.id)).toEqual({
      location: 'local',
      projectId: 'local-1',
    })
  })

  test('unwraps cloud ids for the backend and returns shared issue ids', async () => {
    const cloud = cloudApi()
    const api = createWeworkCollaborationApi(services(cloud))
    const [project] = await api.listProjects()

    const snapshot = await api.getBoardSnapshot(project.id)

    expect(cloud.getBoardSnapshot).toHaveBeenCalledWith('cloud-1')
    expect(snapshot.items[0].id).toContain('wework-resource:')
    await api.updateIssue(snapshot.items[0].id, {
      version: 1,
      status: 'in_progress',
    })
    expect(cloud.updateIssue).toHaveBeenCalledWith('issue-1', {
      version: 1,
      status: 'in_progress',
    })
  })

  test('adapts local project comments to the shared comment contract', async () => {
    const workbenchServices = services(cloudApi())
    const unsubscribe = vi.fn()
    workbenchServices.localProjectChatClient = {
      subscribe: vi.fn().mockResolvedValue({
        snapshot: {
          messages: [
            {
              messageId: 'comment-1',
              content: 'Local progress',
              sender: { type: 'user', id: '1', name: 'Ada' },
              createdAt: '2026-09-10T00:00:00Z',
              updatedAt: '2026-09-10T00:00:00Z',
            },
          ],
        },
        unsubscribe,
      }),
      send: vi.fn(),
    } as unknown as NonNullable<WorkbenchServices['localProjectChatClient']>
    const api = createWeworkCollaborationApi(workbenchServices)
    const issueId = collaborationIssueId({ location: 'local', projectId: 'local-1' }, 'issue-1')

    await expect(api.listComments(issueId)).resolves.toEqual([
      expect.objectContaining({
        id: 'comment-1',
        body: 'Local progress',
        author: 'Ada',
      }),
    ])
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  test('keeps cloud robots, hooks, and automations on the shared backend contract', async () => {
    const cloud = cloudApi()
    vi.mocked(cloud.createAgent).mockResolvedValue({ id: 'agent-1', name: 'Shared bot' })
    vi.mocked(cloud.createIncomingHook).mockResolvedValue({
      id: 'hook-1',
      projectId: 'cloud-1',
      name: 'GitHub',
      status: 'active',
      sourceType: 'github',
      collectionMode: 'webhook',
      resource: { url: 'https://github.com/acme/app' },
      webhookUrl: 'https://example.test/hook-1',
      pollIntervalSeconds: null,
      credentialRef: null,
      health: {},
      lastEventAt: null,
      nextPollAt: null,
      version: 1,
      createdAt: '2026-09-10T00:00:00Z',
      updatedAt: '2026-09-10T00:00:00Z',
    })
    const api = createWeworkCollaborationApi(services(cloud))
    const [project] = await api.listProjects()

    await api.createAgent(project.id, { name: 'Shared bot', runtime: 'codex' })
    await api.createIncomingHook(project.id, {
      name: 'GitHub',
      sourceType: 'github',
      collectionMode: 'webhook',
      resource: { url: 'https://github.com/acme/app' },
    })

    expect(cloud.createAgent).toHaveBeenCalledWith('cloud-1', {
      name: 'Shared bot',
      runtime: 'codex',
    })
    expect(cloud.createIncomingHook).toHaveBeenCalledWith(
      'cloud-1',
      expect.objectContaining({ sourceType: 'github' })
    )
  })
})
