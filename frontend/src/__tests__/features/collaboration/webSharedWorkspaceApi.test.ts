// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  createWebSharedWorkspaceApi,
  WEB_SHARED_WORKSPACE_CAPABILITIES,
  type WebWorkspaceHttpClient,
} from '@/features/collaboration/shared-api/webSharedWorkspaceApi'

function createClient() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    postForm: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  } satisfies jest.Mocked<WebWorkspaceHttpClient>
}

describe('createWebSharedWorkspaceApi', () => {
  it('maps project and issue inputs to backend snake_case fields', async () => {
    const client = createClient()
    client.post.mockResolvedValue({ id: 'issue-1' })
    client.patch.mockResolvedValue({ id: 'project-1' })
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })

    await api.projects.create({
      name: 'GitLab board',
      description: 'Cloud project',
      taskProvider: 'gitlab',
      providerConfig: {
        repository: 'group/project',
        api_base: 'https://gitlab.example.com/api/v4',
      },
      visibility: 'public',
    })
    await api.projects.update('project/1', {
      version: 3,
      providerConfig: { repository: 'owner/repo' },
      pullRequestAutomation: { enabled: true },
    })
    await api.issues.create('project/1', {
      title: 'Ship it',
      dueAt: '2026-09-12T00:00:00Z',
      parentId: 'parent-1',
      executionConfig: { runtimeProfileId: 'profile-1' },
    })

    expect(client.patch).toHaveBeenCalledWith('/v1/cloud-projects/project%2F1', {
      version: 3,
      provider_config: { repository: 'owner/repo' },
      pull_request_automation: { enabled: true },
    })
    expect(client.post).toHaveBeenCalledWith('/v1/cloud-projects', {
      name: 'GitLab board',
      description: 'Cloud project',
      task_provider: 'gitlab',
      provider_config: {
        repository: 'group/project',
        api_base: 'https://gitlab.example.com/api/v4',
      },
      visibility: 'public',
    })
    expect(client.post).toHaveBeenCalledWith('/v1/cloud-projects/project%2F1/loop-items', {
      title: 'Ship it',
      due_at: '2026-09-12T00:00:00Z',
      parent_id: 'parent-1',
      execution_config: { runtime_profile_id: 'profile-1' },
    })
  })

  it('maps paged task bindings and workflow plans at the adapter boundary', async () => {
    const client = createClient()
    client.get
      .mockResolvedValueOnce({
        items: [],
        next_cursor: 'cursor-2',
        task_bindings: [
          {
            id: '42',
            cloud_project_id: '11',
            loop_item_id: 'issue-1',
            task_user_id: 7,
            device_id: 'device-1',
            task_id: 'task-1',
            task_title: 'Task',
            backend_task_id: 99,
            modelSelection: { model: 'gpt' },
            workflow_node_id: 'node-1',
            linked_at: '2026-09-10T00:00:00Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        run_id: 'run-1',
        issue_id: 'issue-1',
        stage_id: 'stage-1',
        plan_version: 2,
        approval_policy: 'required',
        status: 'awaiting_approval',
        summary: 'Plan',
        items: [{ title: 'Child' }],
        manager_run: { id: 'manager-1' },
      })
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })

    await expect(
      api.issues.listPage('11', { status: 'pending', parentId: null, limit: 20 })
    ).resolves.toEqual({
      items: [],
      nextCursor: 'cursor-2',
      taskBindings: [
        {
          id: '42',
          projectId: '11',
          issueId: 'issue-1',
          taskUserId: 7,
          deviceId: 'device-1',
          taskId: 'task-1',
          taskTitle: 'Task',
          backendTaskId: 99,
          modelSelection: { model: 'gpt' },
          workflowNodeId: 'node-1',
          linkedAt: '2026-09-10T00:00:00Z',
        },
      ],
    })
    await expect(api.workflowPlans.get!('issue-1')).resolves.toMatchObject({
      runId: 'run-1',
      issueId: 'issue-1',
      planVersion: 2,
      status: 'awaiting_approval',
    })
  })

  it('maps workflow stage context with the shared DTO contract', async () => {
    const client = createClient()
    client.get.mockResolvedValue({
      compiled_task_instruction: 'Run the deployment',
      source: 'delivery',
    })
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })

    await expect(api.workflowPlans.getStageContext('issue-1', 'node-1')).resolves.toEqual({
      compiledTaskInstruction: 'Run the deployment',
      source: 'delivery',
    })
    expect(client.get).toHaveBeenCalledWith(
      '/v1/loop-items/issue-1/workflow-nodes/node-1/input-context'
    )
  })

  it('uses multipart transport and the authenticated binary transport', async () => {
    const client = createClient()
    const blob = new Blob(['content'])
    const getBlob = jest.fn().mockResolvedValue(blob)
    client.postForm.mockResolvedValue({ id: 'attachment-1' })
    const api = createWebSharedWorkspaceApi(client, { getBlob })
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

    await api.attachments.upload('issue-1', file)
    await expect(api.attachments.read('attachment/1')).resolves.toBe(blob)

    expect(client.postForm).toHaveBeenCalledWith(
      '/v1/loop-items/issue-1/attachments',
      expect.any(FormData)
    )
    expect(getBlob).toHaveBeenCalledWith('/v1/loop-item-attachments/attachment%2F1/content')
  })

  it('maps project attachment APIs and team assignment to backend endpoints', async () => {
    const client = createClient()
    client.get.mockResolvedValue({ items: [{ id: 'attachment-1' }] })
    client.post.mockResolvedValue([{ id: 'attachment-2' }])
    client.patch.mockResolvedValue({ id: 'issue-1', assignee_team_id: 9 })
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })

    await expect(api.attachments.listProjectTaskAttachments('11')).resolves.toEqual([
      { id: 'attachment-1' },
    ])
    await expect(api.attachments.importContexts('issue-1', [1])).resolves.toEqual([
      { id: 'attachment-2' },
    ])
    expect(client.get).toHaveBeenCalledWith('/v1/cloud-projects/11/task-attachments')
    expect(client.post).toHaveBeenCalledWith('/v1/loop-items/issue-1/attachments/import-contexts', {
      context_ids: [1],
    })
    await api.issues.assign('11', 'issue-1', {
      version: 1,
      assigneeType: 'team',
      assigneeId: '9',
      notifyAssignee: false,
    })
    expect(client.patch).toHaveBeenCalledWith('/v1/loop-items/issue-1', {
      version: 1,
      assignee_team_id: 9,
      notify_assignee: false,
    })
    expect(() =>
      api.issues.assign('11', 'issue-1', {
        version: 1,
        assigneeType: 'team',
        assigneeId: 'not-a-number',
      })
    ).toThrow(TypeError)
  })

  it('builds the shared automation execution and plugin catalogs from Web APIs', async () => {
    const client = createClient()
    client.get
      .mockResolvedValueOnce({
        items: [
          {
            device_id: 'device-cloud',
            name: 'Cloud Runner',
            status: 'online',
            device_type: 'cloud',
          },
          {
            device_id: 'device-offline',
            name: 'Offline Runner',
            status: 'offline',
            device_type: 'cloud',
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: 'gpt-web',
            displayName: 'GPT Web',
            type: 'public',
            namespace: 'default',
            resourceUserId: 0,
            config: { reasoning_effort: 'high', ignored: true },
            isActive: true,
            modelCategoryType: 'llm',
          },
        ],
      })
      .mockResolvedValueOnce([
        {
          id: 'profile-cloud',
          name: 'Cloud GPT',
          executionEnvironment: 'cloud',
          executionDeviceId: 'device-cloud',
          model: 'gpt-web',
          modelType: 'public',
          modelOptions: { reasoning_effort: 'medium' },
          status: 'active',
          version: 2,
        },
      ])
      .mockResolvedValueOnce({
        items: [
          {
            metadata: { name: 'plugin-github' },
            spec: {
              enabled: true,
              installState: 'installed',
              displayName: 'GitHub',
              source: {
                pluginKey: 'github',
                marketplace: 'official',
              },
            },
          },
        ],
      })
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })

    await expect(api.automationExecutionCatalog!.load('project-1')).resolves.toEqual({
      environments: [
        {
          deviceId: 'device-cloud',
          label: 'Cloud Runner',
          executionEnvironment: 'cloud',
        },
      ],
      models: [
        {
          name: 'gpt-web',
          label: 'GPT Web',
          type: 'public',
          options: {
            reasoning_effort: 'high',
            weworkCloudModelNamespace: 'default',
            weworkCloudModelResourceUserId: '0',
          },
        },
      ],
      runtimeProfiles: [
        expect.objectContaining({
          id: 'profile-cloud',
          executionDeviceId: 'device-cloud',
          model: 'gpt-web',
          modelOptions: { reasoning_effort: 'medium' },
        }),
      ],
      plugins: [],
    })
    await expect(
      api.automationExecutionCatalog!.loadPlugins('project-1', ['device-cloud'])
    ).resolves.toEqual([
      {
        id: 'github@official',
        label: 'GitHub',
        reference: {
          id: 'github@official',
          pluginName: 'github',
          marketplaceId: 'official',
          displayName: 'GitHub',
        },
      },
    ])
    expect(client.get).toHaveBeenCalledWith('/plugins/installed?device_id=device-cloud')
  })

  it('keeps upload/local automation plugins by normalized fallback identities', async () => {
    const client = createClient()
    client.get.mockResolvedValueOnce({
      items: [
        {
          metadata: { name: 'uploaded-record' },
          spec: {
            enabled: true,
            installState: 'installed',
            displayName: 'Uploaded tools',
            source: {
              type: 'upload',
              pluginKey: 'uploaded-tools',
              providerKey: 'codex-local',
            },
            manifest: {},
          },
        },
        {
          metadata: { name: 'local-record' },
          spec: {
            enabled: true,
            installState: 'installed',
            displayName: 'Personal tools',
            source: {
              type: 'local',
              pluginKey: 'personal-tools',
              providerKey: 'codex-local',
            },
            manifest: {
              marketplaceId: 'personal-marketplace',
            },
          },
        },
      ],
    })
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })

    await expect(
      api.automationExecutionCatalog!.loadPlugins('project-1', ['device-cloud'])
    ).resolves.toEqual([
      {
        id: 'personal-tools@personal-marketplace',
        label: 'Personal tools',
        reference: {
          id: 'personal-tools@personal-marketplace',
          pluginName: 'personal-tools',
          marketplaceId: 'personal-marketplace',
          displayName: 'Personal tools',
        },
      },
      {
        id: 'uploaded-tools@codex-local',
        label: 'Uploaded tools',
        reference: {
          id: 'uploaded-tools@codex-local',
          pluginName: 'uploaded-tools',
          marketplaceId: 'codex-local',
          displayName: 'Uploaded tools',
        },
      },
    ])
  })

  it('publishes a complete and non-silent capability matrix', () => {
    const unsupported = WEB_SHARED_WORKSPACE_CAPABILITIES.filter(
      capability => capability.status === 'unsupported'
    )
    const partial = WEB_SHARED_WORKSPACE_CAPABILITIES.filter(
      capability => capability.status === 'partial'
    )
    const supported = WEB_SHARED_WORKSPACE_CAPABILITIES.filter(
      capability => capability.status === 'supported'
    )

    expect(unsupported).toEqual([])
    expect(partial).toEqual([])
    expect(supported).toHaveLength(98)
    expect(WEB_SHARED_WORKSPACE_CAPABILITIES).toHaveLength(98)
    expect(
      WEB_SHARED_WORKSPACE_CAPABILITIES.some(
        capability =>
          capability.capability === 'projects.listMyWork' ||
          capability.endpoint?.includes('/cloud-work-items/my-work')
      )
    ).toBe(false)
    expect(
      WEB_SHARED_WORKSPACE_CAPABILITIES.every(
        item => item.status === 'supported' || Boolean(item.reason)
      )
    ).toBe(true)
  })

  it('does not expose a My Work port from the Web adapter', () => {
    const api = createWebSharedWorkspaceApi(createClient(), { getBlob: jest.fn() })

    expect(api.myWork).toBeUndefined()
  })
})
