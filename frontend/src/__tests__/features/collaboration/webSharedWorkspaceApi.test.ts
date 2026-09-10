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
          id: 42,
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
    await expect(api.workflowPlans.get('issue-1')).resolves.toMatchObject({
      runId: 'run-1',
      issueId: 'issue-1',
      planVersion: 2,
      status: 'awaiting_approval',
    })
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
    expect(supported).toHaveLength(90)
    expect(WEB_SHARED_WORKSPACE_CAPABILITIES).toHaveLength(90)
    expect(
      WEB_SHARED_WORKSPACE_CAPABILITIES.every(
        item => item.status === 'supported' || Boolean(item.reason)
      )
    ).toBe(true)
  })
})
