// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'
import { createSharedWorkspaceAutomationPorts } from '@wegent/collaboration/automation-ui'
import type {
  CloudLoopItem,
  CloudLoopItemCollaborator,
  CloudProject,
  CloudProjectFile,
  Delivery,
  DeliveryAsset,
  DeliveryDetail,
  LoopItemTaskBinding,
  ProjectBoardSnapshot,
  ProjectDeliveryFile,
  WorkflowPlan,
  createDeliveryApi,
} from '@/api/deliveries'
import {
  WEWORK_DELIVERY_SHARED_WORKSPACE_METHODS,
  WEWORK_DELIVERY_SHARED_WORKSPACE_MISSING_METHODS,
  WEWORK_SHARED_WORKSPACE_MISSING_METHODS,
  createWeworkAutomationSharedWorkspaceApi,
  createWeworkDeliverySharedWorkspaceApi,
  createWeworkSharedWorkspaceApi,
  createWeworkWorkspaceRuntimePort,
} from './weworkSharedWorkspaceApi'

type DeliveryApi = ReturnType<typeof createDeliveryApi>

const project = {
  id: 'project-1',
  project_key: 'PROJ',
  name: 'Project',
} as CloudProject

const issue = {
  id: 'issue-1',
  cloud_project_id: 'project-1',
  title: 'Issue',
  status: 'pending',
  version: 3,
} as CloudLoopItem

const binding: LoopItemTaskBinding = {
  id: 4,
  cloud_project_id: 'project-1',
  loop_item_id: 'issue-1',
  task_user_id: 7,
  device_id: 'device-1',
  task_id: 'task-1',
  task_title: 'Task',
  backend_task_id: 9,
  modelSelection: { model: 'gpt-5' },
  workflow_node_id: 'node-1',
  binding_type: 'user',
  linked_at: '2026-09-10T00:00:00Z',
}

const collaborator: CloudLoopItemCollaborator = {
  id: 'collaborator-1',
  loop_item_id: 'issue-1',
  user_id: 8,
  user_name: 'User',
  email: 'user@example.com',
  source: 'manual',
  added_by_user_id: 1,
  created_at: '2026-09-10T00:00:00Z',
}

const workflowPlan: WorkflowPlan = {
  run_id: 'run-1',
  issue_id: 'issue-1',
  stage_id: 'stage-1',
  plan_version: 2,
  approval_policy: 'required',
  status: 'awaiting_approval',
  summary: 'Plan',
  items: [
    {
      id: 'item-1',
      client_key: 'client-1',
      stage_id: 'stage-1',
      title: 'Child',
      description: '',
      assignee_type: 'user',
      assignee_id: '8',
      assignee_name: 'User',
      rationale: '',
      status: 'proposed',
    },
  ],
  manager_run: {
    id: 'manager-1',
    status: 'running',
    recent_activity: 'Planning',
    updated_at: '2026-09-10T00:00:00Z',
  },
}

const deliveryAsset: DeliveryAsset = {
  id: 'asset-1',
  kind: 'file',
  display_name: 'report.txt',
  relative_path: 'report.txt',
  content_type: 'text/plain',
  size_bytes: 12,
  sha256: 'sha',
}

const delivery: Delivery = {
  id: 'delivery-1',
  loop_item_id: 'issue-1',
  created_by_user_id: 8,
  source_task_binding_id: null,
  source_task_snapshot: null,
  status: 'draft',
  created_at: '2026-09-10T00:00:00Z',
  delivered_at: null,
  assets: [deliveryAsset],
  fulfillments: [],
}

const deliveryDetail: DeliveryDetail = {
  ...delivery,
  markdown: '# Result',
  chat: { message: 'done' },
}

const cloudFile = {
  id: 'file-1',
  cloud_project_id: 'project-1',
  path: 'docs/report.txt',
  name: 'report.txt',
  kind: 'file',
} as CloudProjectFile

const deliveryFile: ProjectDeliveryFile = {
  asset_id: 'asset-1',
  delivery_id: 'delivery-1',
  loop_item_id: 'issue-1',
  loop_item_title: 'Issue',
  relative_path: 'report.txt',
  display_name: 'report.txt',
  content_type: 'text/plain',
  size_bytes: 12,
  delivered_at: '2026-09-10T00:00:00Z',
  loop_item_path: [{ id: 'issue-1', title: 'Issue' }],
}

function createMockDeliveryApi() {
  return {
    listCloudProjects: vi.fn().mockResolvedValue({ items: [project] }),
    createCloudProject: vi.fn().mockResolvedValue(project),
    updateCloudProject: vi.fn().mockResolvedValue(project),
    archiveCloudProject: vi.fn().mockResolvedValue(undefined),
    listMyWork: vi.fn().mockResolvedValue({ items: [issue] }),
    listLoopItems: vi.fn().mockResolvedValue({ items: [issue] }),
    listLoopItemsPage: vi.fn().mockResolvedValue({
      items: [issue],
      task_bindings: [binding],
      next_cursor: 'next',
    }),
    getBoardSnapshot: vi.fn().mockResolvedValue({
      items: [issue],
      task_bindings: [binding],
      members: [],
      agents: [],
    } satisfies ProjectBoardSnapshot),
    getLoopItem: vi.fn().mockResolvedValue(issue),
    createLoopItem: vi.fn().mockResolvedValue(issue),
    updateLoopItem: vi.fn().mockResolvedValue(issue),
    assignLoopItem: vi.fn().mockResolvedValue(issue),
    approveLoopItemRun: vi.fn().mockResolvedValue(issue),
    rejectLoopItemRun: vi.fn().mockResolvedValue(issue),
    archiveLoopItem: vi.fn().mockResolvedValue(undefined),
    reorderLoopItems: vi.fn().mockResolvedValue({ items: [issue] }),
    markLoopItemRead: vi.fn().mockResolvedValue(issue),
    listLoopItemAttachments: vi.fn().mockResolvedValue([]),
    listProjectTaskAttachments: vi.fn().mockResolvedValue({ items: [] }),
    addLoopItemAttachment: vi.fn().mockResolvedValue({ id: 'attachment-1' }),
    importLoopItemAttachments: vi.fn().mockResolvedValue([]),
    accessLoopItemAttachment: vi
      .fn()
      .mockResolvedValue({ url: 'attachment-url', expires_in_seconds: 60 }),
    readLoopItemAttachment: vi.fn().mockResolvedValue(new Blob(['attachment'])),
    deleteLoopItemAttachment: vi.fn().mockResolvedValue(undefined),
    listLoopItemCollaborators: vi.fn().mockResolvedValue([collaborator]),
    addLoopItemCollaborator: vi.fn().mockResolvedValue(collaborator),
    removeLoopItemCollaborator: vi.fn().mockResolvedValue(undefined),
    listTaskBindings: vi.fn().mockResolvedValue([binding]),
    findLoopItemForTask: vi.fn().mockResolvedValue(issue),
    findCloudContextForTask: vi.fn().mockResolvedValue({
      project,
      loop_item_id: issue.id,
      workflow_node_id: 'node-1',
    }),
    bindTask: vi.fn().mockResolvedValue(undefined),
    unbindTask: vi.fn().mockResolvedValue(undefined),
    unbindCloudContext: vi.fn().mockResolvedValue(undefined),
    trackProjectTask: vi.fn().mockResolvedValue({ item: issue }),
    updateTaskTrackingStatus: vi.fn().mockResolvedValue(issue),
    updateTaskTrackingTitle: vi.fn().mockResolvedValue(issue),
    getWorkflowPlan: vi.fn().mockResolvedValue(workflowPlan),
    approveWorkflowPlan: vi.fn().mockResolvedValue(workflowPlan),
    approveWorkflowReview: vi.fn().mockResolvedValue(workflowPlan),
    pauseWorkflowPlan: vi.fn().mockResolvedValue(workflowPlan),
    resumeWorkflowPlan: vi.fn().mockResolvedValue(workflowPlan),
    replanWorkflowPlan: vi.fn().mockResolvedValue(workflowPlan),
    decideWorkflowNode: vi.fn().mockResolvedValue(issue),
    getWorkflowStageContext: vi
      .fn()
      .mockResolvedValue({ compiled_task_instruction: 'Instruction', source: 'delivery' }),
    listCloudProjectMembers: vi.fn().mockResolvedValue([]),
    searchCloudProjectUsers: vi.fn().mockResolvedValue({ users: [], total: 0 }),
    addCloudProjectMember: vi.fn().mockResolvedValue({ id: 1 }),
    updateCloudProjectMember: vi.fn().mockResolvedValue({ id: 1 }),
    removeCloudProjectMember: vi.fn().mockResolvedValue(undefined),
    listCloudFiles: vi.fn().mockResolvedValue({
      items: [cloudFile, { ...cloudFile, id: 'file-2', path: 'other.txt' }],
    }),
    listProjectDeliveryFiles: vi.fn().mockResolvedValue({ items: [deliveryFile] }),
    createCloudFolder: vi.fn().mockResolvedValue(cloudFile),
    uploadCloudFile: vi.fn().mockResolvedValue(cloudFile),
    accessCloudFile: vi.fn().mockResolvedValue({ url: 'file-url', expires_in_seconds: 120 }),
    readCloudFile: vi.fn().mockResolvedValue(new Blob(['file'])),
    moveCloudFile: vi.fn().mockResolvedValue(cloudFile),
    deleteCloudFile: vi.fn().mockResolvedValue(undefined),
    accessDeliveryFile: vi.fn().mockResolvedValue({ url: 'delivery-url', expires_in_seconds: 180 }),
    readDeliveryFile: vi.fn().mockResolvedValue(new Blob(['delivery'])),
    listDeliveries: vi.fn().mockResolvedValue({ items: [delivery] }),
    getDelivery: vi.fn().mockResolvedValue(deliveryDetail),
    createDelivery: vi.fn().mockResolvedValue(delivery),
    addAsset: vi.fn().mockResolvedValue(deliveryAsset),
    finalizeDelivery: vi.fn().mockResolvedValue({ ...delivery, status: 'delivered' }),
    discardDraft: vi.fn().mockResolvedValue(undefined),
    listLoopItemExecutions: vi.fn().mockResolvedValue({ items: [] }),
    stopExecution: vi.fn().mockResolvedValue({ id: 5, status: 'cancelled' }),
  } as unknown as DeliveryApi
}

describe('createWeworkDeliverySharedWorkspaceApi', () => {
  it('maps project and issue methods and converts transport casing', async () => {
    const deliveryApi = createMockDeliveryApi()
    const api = createWeworkDeliverySharedWorkspaceApi(deliveryApi)

    await expect(api.projects.list()).resolves.toEqual([project])
    await api.projects.create({
      projectKey: 'PROJ',
      name: 'Project',
      description: 'Description',
      taskProvider: 'local',
      visibility: 'private',
      providerConfig: { repository: 'repo' },
    })
    expect(deliveryApi.createCloudProject).toHaveBeenCalledWith({
      project_key: 'PROJ',
      name: 'Project',
      description: 'Description',
      task_provider: 'local',
      visibility: 'private',
      provider_config: { repository: 'repo' },
    })
    await api.projects.update('project-1', {
      version: 2,
      boardConfig: project.board_config,
      cardDisplay: project.card_display,
      pullRequestAutomation: { enabled: true },
      workflowDefinition: { version: 1 },
    })
    expect(deliveryApi.updateCloudProject).toHaveBeenCalledWith('project-1', {
      version: 2,
      pull_request_automation: { enabled: true },
      workflow_definition: { version: 1 },
    })
    await api.projects.archive('project-1', 2)
    await expect(api.myWork.list()).resolves.toEqual([issue])

    await api.issues.list('project-1', { assigneeType: 'user', assigneeId: 8 })
    await expect(
      api.issues.listPage('project-1', {
        status: 'pending',
        parentId: null,
        cursor: 'cursor',
        limit: 20,
      })
    ).resolves.toMatchObject({
      items: [issue],
      nextCursor: 'next',
      taskBindings: [
        {
          id: 4,
          projectId: 'project-1',
          issueId: 'issue-1',
          taskUserId: 7,
          deviceId: 'device-1',
          taskId: 'task-1',
          taskTitle: 'Task',
          backendTaskId: 9,
          modelSelection: { model: 'gpt-5' },
          workflowNodeId: 'node-1',
          bindingType: 'user',
          linkedAt: '2026-09-10T00:00:00Z',
        },
      ],
    })
    await expect(api.issues.getBoardSnapshot('project-1')).resolves.toEqual({
      items: [issue],
      taskBindings: expect.any(Array),
      members: [],
      agents: [],
    })
    await api.issues.get('issue-1')
    await api.issues.create('project-1', {
      title: 'Issue',
      dueAt: '2026-09-11',
      parentId: null,
      localProjectId: 3,
      automationRuleId: 'automation-1',
    })
    expect(deliveryApi.createLoopItem).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        title: 'Issue',
        due_at: '2026-09-11',
        parent_id: null,
        local_project_id: 3,
        automation_rule_id: 'automation-1',
      })
    )
    await api.issues.update('issue-1', {
      version: 3,
      assigneeUserId: 8,
      dueAt: null,
      automationRuleId: null,
    })
    expect(deliveryApi.updateLoopItem).toHaveBeenCalledWith(
      'issue-1',
      expect.objectContaining({
        version: 3,
        assignee_user_id: 8,
        due_at: null,
        automation_rule_id: null,
      })
    )
    await api.issues.assign('project-1', 'issue-1', {
      version: 3,
      assigneeType: 'user',
      assigneeId: '8',
    })
    await api.issues.approveRun('project-1', 'issue-1', 3)
    await api.issues.rejectRun('project-1', 'issue-1', 3, 'Needs changes')
    await api.issues.archive('issue-1')
    await api.issues.reorder('project-1', {
      parentId: null,
      status: 'pending',
      issueIds: ['issue-1'],
    })
    expect(deliveryApi.reorderLoopItems).toHaveBeenCalledWith('project-1', {
      parent_id: null,
      status: 'pending',
      item_ids: ['issue-1'],
    })
    await api.issues.markRead('issue-1')
  })

  it('omits absent project and issue fields while preserving explicit null values', async () => {
    const deliveryApi = createMockDeliveryApi()
    const api = createWeworkDeliverySharedWorkspaceApi(deliveryApi)

    await api.projects.create({ name: 'Minimal project' })
    expect(deliveryApi.createCloudProject).toHaveBeenLastCalledWith({
      name: 'Minimal project',
    })

    await api.projects.update('project-1', {
      version: 4,
      description: '',
    })
    expect(deliveryApi.updateCloudProject).toHaveBeenLastCalledWith('project-1', {
      version: 4,
      description: '',
    })

    await api.issues.create('project-1', {
      title: 'Child issue',
      parentId: null,
      workflow: null,
    })
    expect(deliveryApi.createLoopItem).toHaveBeenLastCalledWith('project-1', {
      title: 'Child issue',
      parent_id: null,
      workflow: null,
    })

    await api.issues.update('issue-1', {
      version: 5,
      parentId: null,
      assigneeUserId: null,
      dueAt: null,
    })
    expect(deliveryApi.updateLoopItem).toHaveBeenLastCalledWith('issue-1', {
      version: 5,
      parent_id: null,
      assignee_user_id: null,
      due_at: null,
    })
  })

  it('uses the request project id only when paged board bindings omit it', async () => {
    const deliveryApi = createMockDeliveryApi()
    const bindingWithoutProject = { ...binding, cloud_project_id: undefined }
    vi.mocked(deliveryApi.listLoopItemsPage).mockResolvedValue({
      items: [issue],
      task_bindings: [bindingWithoutProject],
      next_cursor: null,
    })
    vi.mocked(deliveryApi.getBoardSnapshot).mockResolvedValue({
      items: [issue],
      task_bindings: [bindingWithoutProject],
      members: [],
      agents: [],
    })
    const api = createWeworkDeliverySharedWorkspaceApi(deliveryApi)

    await expect(
      api.issues.listPage('project-42', {
        status: 'pending',
        parentId: null,
      })
    ).resolves.toMatchObject({
      taskBindings: [{ projectId: 'project-42' }],
    })
    await expect(api.issues.getBoardSnapshot('project-42')).resolves.toMatchObject({
      taskBindings: [{ projectId: 'project-42' }],
    })
  })

  it('keeps an explicit binding project id and normalizes it to a string', async () => {
    const deliveryApi = createMockDeliveryApi()
    const numericProjectBinding = {
      ...binding,
      cloud_project_id: 9001,
    }
    vi.mocked(deliveryApi.listLoopItemsPage).mockResolvedValue({
      items: [issue],
      task_bindings: [numericProjectBinding],
      next_cursor: null,
    })
    const api = createWeworkDeliverySharedWorkspaceApi(deliveryApi)

    await expect(
      api.issues.listPage('request-project', {
        status: 'pending',
        parentId: null,
      })
    ).resolves.toMatchObject({
      taskBindings: [{ projectId: '9001' }],
    })
  })

  it('maps attachments, collaborators, task bindings, workflow plans, and members', async () => {
    const deliveryApi = createMockDeliveryApi()
    const api = createWeworkDeliverySharedWorkspaceApi(deliveryApi)
    const file = new File(['content'], 'report.txt', { type: 'text/plain' })

    await api.attachments.list('issue-1')
    await api.attachments.listProjectTaskAttachments('project-1')
    await api.attachments.upload('issue-1', file)
    await api.attachments.importContexts('issue-1', [3, 5])
    expect(deliveryApi.importLoopItemAttachments).toHaveBeenCalledWith('issue-1', [
      { id: 3 },
      { id: 5 },
    ])
    await expect(api.attachments.access('attachment-1')).resolves.toEqual({
      url: 'attachment-url',
      expiresInSeconds: 60,
    })
    await api.attachments.read('attachment-1')
    await api.attachments.remove('attachment-1')

    await expect(api.collaborators.list('issue-1')).resolves.toEqual([
      {
        id: 'collaborator-1',
        issueId: 'issue-1',
        userId: 8,
        userName: 'User',
        email: 'user@example.com',
        source: 'manual',
        addedByUserId: 1,
        createdAt: '2026-09-10T00:00:00Z',
      },
    ])
    await api.collaborators.add('issue-1', 8)
    await api.collaborators.remove('issue-1', 8)
    await api.taskBindings.list('issue-1')

    await expect(api.workflowPlans.get('issue-1')).resolves.toMatchObject({
      runId: 'run-1',
      issueId: 'issue-1',
      stageId: 'stage-1',
      planVersion: 2,
      managerRun: { id: 'manager-1' },
    })
    await api.workflowPlans.approve('issue-1')
    await api.workflowPlans.approveReview('issue-1')
    await api.workflowPlans.pause('issue-1')
    await api.workflowPlans.resume('issue-1')
    await api.workflowPlans.replan('issue-1')
    await api.workflowPlans.decideNode('issue-1', 'node-1', 'reject', 'No')
    await expect(api.workflowPlans.getStageContext('issue-1', 'node-1')).resolves.toEqual({
      compiledTaskInstruction: 'Instruction',
      source: 'delivery',
    })

    await api.members.list('project-1')
    await api.members.searchUsers('user')
    await api.members.add('project-1', 8, 'Developer')
    await api.members.update('project-1', 8, {
      role: 'Maintainer',
      capabilityDescription: 'Reviewer',
    })
    expect(deliveryApi.updateCloudProjectMember).toHaveBeenCalledWith('project-1', 8, {
      role: 'Maintainer',
      capability_description: 'Reviewer',
    })
    await api.members.remove('project-1', 8)
  })

  it('maps files, deliveries, and executions without desktop side effects', async () => {
    const deliveryApi = createMockDeliveryApi()
    const api = createWeworkDeliverySharedWorkspaceApi(deliveryApi)
    const file = new File(['content'], 'report.txt', { type: 'text/plain' })

    await expect(api.files.list('project-1', '/docs/')).resolves.toEqual([cloudFile])
    await expect(api.files.listDeliveryFiles('project-1')).resolves.toEqual([
      {
        assetId: 'asset-1',
        deliveryId: 'delivery-1',
        issueId: 'issue-1',
        issueTitle: 'Issue',
        relativePath: 'report.txt',
        displayName: 'report.txt',
        contentType: 'text/plain',
        sizeBytes: 12,
        deliveredAt: '2026-09-10T00:00:00Z',
        issuePath: [{ id: 'issue-1', title: 'Issue' }],
      },
    ])
    await api.files.createFolder('project-1', 'docs')
    await api.files.upload('project-1', file, 'docs/report.txt')
    await expect(api.files.access('file-1')).resolves.toEqual({
      url: 'file-url',
      expiresInSeconds: 120,
    })
    await api.files.read('file-1')
    await api.files.move('file-1', 'archive/report.txt', 2)
    await api.files.remove('file-1', true)
    await expect(api.files.accessDeliveryFile('asset-1')).resolves.toEqual({
      url: 'delivery-url',
      expiresInSeconds: 180,
    })
    await api.files.readDeliveryFile('asset-1')

    await expect(api.deliveries.list('issue-1')).resolves.toMatchObject([
      { id: 'delivery-1', issueId: 'issue-1', assets: [{ displayName: 'report.txt' }] },
    ])
    await expect(api.deliveries.get('delivery-1')).resolves.toMatchObject({
      markdown: '# Result',
      chat: { message: 'done' },
    })
    await api.deliveries.create('issue-1', { markdown: '# Result' })
    await api.deliveries.addAsset('delivery-1', file, 'report.txt')
    await api.deliveries.finalize('delivery-1', { fulfillments: [] })
    await api.deliveries.discardDraft('delivery-1')

    await api.executions.list('project-1', { agentId: 'agent-1', status: 'running' })
    expect(deliveryApi.listLoopItemExecutions).toHaveBeenCalledWith('project-1', {
      agent_id: 'agent-1',
      status: 'running',
    })
    await api.executions.stop('project-1', 5)
  })

  it('publishes an exact compile-time inventory instead of fake unsupported methods', () => {
    const api = createWeworkDeliverySharedWorkspaceApi(createMockDeliveryApi())
    for (const domain of Object.keys(WEWORK_DELIVERY_SHARED_WORKSPACE_METHODS) as Array<
      keyof typeof WEWORK_DELIVERY_SHARED_WORKSPACE_METHODS
    >) {
      expect(Object.keys(api[domain]).sort()).toEqual(
        [...WEWORK_DELIVERY_SHARED_WORKSPACE_METHODS[domain]].sort()
      )
    }
    expect(WEWORK_DELIVERY_SHARED_WORKSPACE_METHODS.projects).toEqual([
      'list',
      'create',
      'update',
      'archive',
    ])
    expect(WEWORK_DELIVERY_SHARED_WORKSPACE_METHODS.myWork).toEqual(['list'])
    expect(WEWORK_DELIVERY_SHARED_WORKSPACE_MISSING_METHODS).toEqual({
      projects: ['get', 'importMessages'],
      comments: ['list', 'create'],
      automations: [
        'list',
        'create',
        'migrateWorkflow',
        'update',
        'remove',
        'runNow',
        'runWorkflowNode',
        'listRuns',
        'cancelRun',
        'retryRun',
      ],
      incomingHooks: ['catalog', 'list', 'create', 'update', 'rotate', 'remove', 'listEvents'],
      runtimeProfiles: [
        'list',
        'create',
        'update',
        'remove',
        'getProjectDefault',
        'setProjectDefault',
        'selectExecution',
      ],
      agents: ['list', 'create', 'update'],
    })
    expect('comments' in api).toBe(false)
  })

  it('rejects incomplete DeliveryApi task bindings instead of inventing a project id', async () => {
    const deliveryApi = createMockDeliveryApi()
    vi.mocked(deliveryApi.listTaskBindings).mockResolvedValue([
      { ...binding, cloud_project_id: undefined },
    ])

    await expect(
      createWeworkDeliverySharedWorkspaceApi(deliveryApi).taskBindings.list('issue-1')
    ).rejects.toThrow('Workspace task binding 4 is missing cloud_project_id')
  })

  it('combines every cloud workspace domain behind one complete API', async () => {
    const client = {
      get: vi.fn().mockImplementation(async (endpoint: string) => {
        if (endpoint.endsWith('/comments')) {
          return [
            {
              id: 'comment-1',
              body: 'Comment',
              author: 'User',
              web_url: null,
              created_at: '2026-09-10T00:00:00Z',
              updated_at: '2026-09-10T00:00:00Z',
            },
          ]
        }
        return project
      }),
      getBlob: vi.fn(),
      post: vi.fn().mockImplementation(async (endpoint: string) => {
        if (endpoint.endsWith('/message-imports')) return { issue }
        return {
          id: 'comment-1',
          body: 'Comment',
          author: 'User',
          web_url: null,
          created_at: '2026-09-10T00:00:00Z',
          updated_at: '2026-09-10T00:00:00Z',
        }
      }),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    }
    const projectAutomationApi = {
      list: vi.fn(),
      create: vi.fn(),
      migrateWorkflow: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(),
      runWorkflowNode: vi.fn(),
      listRuns: vi.fn(),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
    }
    const projectIncomingHookApi = {
      catalog: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      rotate: vi.fn(),
      remove: vi.fn(),
      listEvents: vi.fn(),
    }
    const runtimeProfileApi = {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getProjectDefault: vi.fn(),
      setProjectDefault: vi.fn(),
      selectExecution: vi.fn().mockResolvedValue({
        id: 7,
        loopItemId: 'issue-1',
        taskTitle: 'Issue',
        executorType: 'project_robot',
        status: 'waiting_runtime',
        displayState: 'waiting_runtime',
        observedState: 'unconfirmed',
        syncState: 'pending',
      }),
    }
    const projectChatAgentApi = {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    }
    const api = createWeworkSharedWorkspaceApi({
      client,
      deliveryApi: createMockDeliveryApi(),
      projectAutomationApi: projectAutomationApi as never,
      projectIncomingHookApi: projectIncomingHookApi as never,
      runtimeProfileApi: runtimeProfileApi as never,
      projectChatAgentApi: projectChatAgentApi as never,
    })

    expect(Object.keys(api).sort()).toEqual(
      [
        'projects',
        'myWork',
        'issues',
        'comments',
        'attachments',
        'collaborators',
        'taskBindings',
        'workflowPlans',
        'members',
        'files',
        'deliveries',
        'executions',
        'automations',
        'incomingHooks',
        'runtimeProfiles',
        'agents',
      ].sort()
    )
    expect(WEWORK_SHARED_WORKSPACE_MISSING_METHODS).toEqual([])

    await expect(api.projects.get('project/1')).resolves.toBe(project)
    expect(client.get).toHaveBeenCalledWith('/v1/cloud-projects/project%2F1')

    await expect(
      api.projects.importMessages('project/1', {
        sourceTaskId: 12,
        subtaskIds: [13],
        target: { kind: 'existing_issue', issueId: 'issue/1' },
        note: 'Context',
      })
    ).resolves.toEqual({ issue })
    expect(client.post).toHaveBeenCalledWith('/v1/cloud-projects/project%2F1/message-imports', {
      source_task_id: 12,
      subtask_ids: [13],
      target: { kind: 'existing_issue', issue_id: 'issue/1' },
      note: 'Context',
    })

    await api.comments.list('issue/1')
    await api.comments.create('issue/1', 'Comment')
    expect(client.get).toHaveBeenCalledWith('/v1/loop-items/issue%2F1/comments')
    expect(client.post).toHaveBeenCalledWith('/v1/loop-items/issue%2F1/comments', {
      body: 'Comment',
    })

    await expect(
      api.runtimeProfiles.selectExecution('project-1', 7, 'profile-1', 2)
    ).resolves.toMatchObject({
      id: 7,
      loop_item_id: 'issue-1',
      task_title: 'Issue',
      executor_type: 'project_robot',
      status: 'waiting_runtime',
      display_state: 'waiting_runtime',
      observed_state: 'unconfirmed',
      sync_state: 'pending',
      started_at: null,
      completed_at: null,
      error_message: null,
    })
  })
})

describe('createWeworkAutomationSharedWorkspaceApi', () => {
  it('routes local automation and legacy workflow clearing through shared ports', async () => {
    const deliveryApi = createMockDeliveryApi()
    const projectAutomationApi = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      migrateWorkflow: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      runNow: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
    }
    const projectIncomingHookApi = {
      catalog: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      rotate: vi.fn(),
      remove: vi.fn(),
    }
    const workspaceApi = createWeworkAutomationSharedWorkspaceApi(
      deliveryApi,
      projectAutomationApi as never,
      projectIncomingHookApi as never
    )
    const ports = createSharedWorkspaceAutomationPorts<CloudProject>(workspaceApi)
    const workflowDefinition = {
      version: 3,
      stage_mode: 'none' as const,
      advancement_policy: 'manual' as const,
      coordinator_prompt: '',
      approval_policy: 'required' as const,
      ai_automation_rule_id: null,
      execution_config: null,
      nodes: [],
    }

    await ports.automationApi.list('project-1')
    await ports.incomingHooksApi.catalog()
    await ports.projectApi.clearLegacyWorkflow(
      { ...project, version: 4 } as CloudProject,
      workflowDefinition
    )

    expect(projectAutomationApi.list).toHaveBeenCalledWith('project-1')
    expect(projectIncomingHookApi.catalog).toHaveBeenCalledOnce()
    expect(deliveryApi.updateCloudProject).toHaveBeenCalledWith('project-1', {
      version: 4,
      workflow_definition: workflowDefinition,
    })
  })
})

describe('createWeworkWorkspaceRuntimePort', () => {
  it('isolates cloud task tracking and automation execution behind the explicit runtime port', async () => {
    const deliveryApi = createMockDeliveryApi()
    const execution = {
      id: 12,
      loop_item_id: issue.id,
      cloud_project_id: project.id,
      task_title: issue.title,
      task_status: null,
      task_priority: null,
      agent_id: 'agent-1',
      assigner_user_id: 8,
      status: 'claimed',
      display_state: 'running',
      observed_state: 'confirmed',
      sync_state: 'synced',
      execution_note: '',
      version: 2,
      created_at: '2026-09-10T00:00:00Z',
      updated_at: '2026-09-10T00:00:00Z',
    }
    const projectAutomationApi = {
      claimNext: vi.fn().mockResolvedValue(execution),
      heartbeat: vi.fn().mockResolvedValue(execution),
      startRequested: vi.fn().mockResolvedValue(execution),
      dispatchUnknown: vi.fn().mockResolvedValue(execution),
      runtimeStart: vi.fn().mockResolvedValue(execution),
      dispatchFailed: vi.fn().mockResolvedValue(execution),
    }
    const port = createWeworkWorkspaceRuntimePort(deliveryApi, projectAutomationApi as never)
    const task = {
      deviceId: 'device-1',
      taskId: 'task-1',
      backendTaskId: 9,
      modelSelection: { model: 'gpt-5' },
    }
    const deliveryTask = {
      deviceId: 'device-1',
      taskId: 'task-1',
      backendTaskId: 9,
      runtimeHandle: {
        modelSelection: { model: 'gpt-5' },
      },
    }

    await expect(port.findIssueForTask(task)).resolves.toEqual(issue)
    await expect(port.findCloudContextForTask(task)).resolves.toEqual({
      project,
      issueId: issue.id,
      workflowNodeId: 'node-1',
    })
    await port.bindTask(issue.id, task, 'Task', 'node-1')
    await port.unbindTask(issue.id, task)
    await port.unbindCloudContext(task)
    await expect(port.trackProjectTask(project.id, task, 'Task', 'Description')).resolves.toEqual({
      issue,
    })
    await expect(port.updateTrackedTaskStatus(task, 'running')).resolves.toEqual(issue)
    await expect(port.updateTrackedTaskTitle(task, 'Renamed')).resolves.toEqual(issue)

    expect(deliveryApi.bindTask).toHaveBeenCalledWith(issue.id, deliveryTask, 'Task', 'node-1')
    expect(deliveryApi.unbindTask).toHaveBeenCalledWith(issue.id, deliveryTask)
    expect(deliveryApi.unbindCloudContext).toHaveBeenCalledWith(deliveryTask)
    expect(deliveryApi.trackProjectTask).toHaveBeenCalledWith(
      project.id,
      deliveryTask,
      'Task',
      'Description'
    )

    await expect(
      port.claimNextExecution({ executionDeviceId: 'device-1', leaseSeconds: 300 })
    ).resolves.toMatchObject({ id: 12, cloud_project_id: project.id })
    expect(projectAutomationApi.claimNext).toHaveBeenCalledWith({
      execution_device_id: 'device-1',
      lease_seconds: 300,
    })

    await port.reportExecutionLifecycle(project.id, 12, {
      type: 'heartbeat',
      runtimeDeviceId: 'device-1',
      runtimeTaskId: 'task-1',
    })
    await port.reportExecutionLifecycle(project.id, 12, {
      type: 'start_requested',
      runtimeDeviceId: 'device-1',
      runtimeTaskId: 'task-1',
    })
    await port.reportExecutionLifecycle(project.id, 12, {
      type: 'dispatch_unknown',
      runtimeDeviceId: 'device-1',
      runtimeTaskId: 'task-1',
      error: 'timeout',
    })
    await port.reportExecutionLifecycle(project.id, 12, {
      type: 'runtime_start',
      runtimeDeviceId: 'device-1',
      runtimeTaskId: 'task-1',
      prompt: 'Run',
      model: 'gpt-5',
    })
    await port.reportExecutionLifecycle(project.id, 12, {
      type: 'dispatch_failed',
      error: 'failed',
    })

    const executionAddress = { id: 12, cloud_project_id: project.id }
    expect(projectAutomationApi.heartbeat).toHaveBeenCalledWith(
      executionAddress,
      'device-1',
      'task-1'
    )
    expect(projectAutomationApi.startRequested).toHaveBeenCalledWith(
      executionAddress,
      'device-1',
      'task-1'
    )
    expect(projectAutomationApi.dispatchUnknown).toHaveBeenCalledWith(
      executionAddress,
      'device-1',
      'task-1',
      'timeout'
    )
    expect(projectAutomationApi.runtimeStart).toHaveBeenCalledWith(
      executionAddress,
      'device-1',
      'task-1',
      'Run',
      'gpt-5'
    )
    expect(projectAutomationApi.dispatchFailed).toHaveBeenCalledWith(executionAddress, 'failed')
  })
})
