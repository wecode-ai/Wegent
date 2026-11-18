// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createWebSharedWorkspaceApi, type WebWorkspaceHttpClient } from './webSharedWorkspaceApi'

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

describe('workspace resource configuration adapter', () => {
  it('forwards the observed content revision with an Issue read receipt', async () => {
    const client = createClient()
    client.post.mockResolvedValue({ id: 'issue-1', is_unread: true })
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })
    await api.issues.markRead('issue-1', 4, 7)
    expect(client.post).toHaveBeenCalledWith('/v1/loop-items/issue-1/read', {
      activity_sequence: 4,
      content_revision: 7,
    })
  })

  it('preserves opaque view extensions and lane sort IDs in project updates', async () => {
    const client = createClient()
    client.patch.mockResolvedValue({})
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })
    const boardViews = {
      schema_version: 1,
      views: [],
      futureExtension: { keepCase: true },
      sorts: { 'Lane-ABC': ['created-asc'] },
    }
    await api.projects.update('project/1', { version: 3, boardViews })
    expect(client.patch).toHaveBeenCalledWith('/v1/cloud-projects/project%2F1', {
      version: 3,
      board_views: boardViews,
    })
  })
  it('serializes policy publishing, admission and explicit snapshot upgrades', async () => {
    const client = createClient()
    client.patch.mockResolvedValue({ id: 'issue-1' })
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })
    const collaborationStrategy = {
      text: '# 协作策略\n\n收集箱 → 需求提出 → 共同评审 → 开发准备 → 开发实现 → 质量验收 → 发布上线',
      expected_version: 1,
    }
    await api.projects.update('project-1', { version: 3, collaborationStrategy })
    expect(client.patch).toHaveBeenLastCalledWith('/v1/cloud-projects/project-1', {
      version: 3,
      collaboration_strategy: collaborationStrategy,
    })
    const intakeDefinition = {
      objective: 'Require evidence before advancement',
      scope: 'Shared collaboration',
      non_goals: 'Automatic deployment',
      acceptance_criteria: 'Incomplete definitions stay in inbox',
      dependencies: 'none',
      proposed_owner: 'product-owner',
    }
    await api.issues.update('issue-1', { version: 4, intakeDefinition, priority: 'high' })
    expect(client.patch).toHaveBeenLastCalledWith('/v1/loop-items/issue-1', {
      version: 4,
      intake_definition: intakeDefinition,
      priority: 'high',
    })
    for (const workflowAction of [
      { type: 'admit', idempotency_key: 'admission-1' },
      { type: 'evaluate', idempotency_key: 'evaluate-1' },
      { type: 'upgrade_strategy', reason: 'Use the reviewed policy', idempotency_key: 'upgrade-1' },
      {
        type: 'decide_node',
        node_id: 'quality_acceptance',
        action: 'reject',
        rework_to: 'development_preparation',
        reason: 'Visual acceptance failed',
        idempotency_key: 'visual-rework-1',
      },
    ] as const) {
      await api.issues.update('issue-1', { version: 5, workflowAction })
      expect(client.patch).toHaveBeenLastCalledWith('/v1/loop-items/issue-1', {
        version: 5,
        workflow_action: workflowAction,
      })
    }
  })

  it('preserves existing workflow snapshots, versioned decisions and stage evidence', async () => {
    const client = createClient()
    client.patch.mockResolvedValue({ id: 'issue-1' })
    client.post.mockResolvedValue({ id: 'delivery-1', fulfillments: [] })
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })
    const definition = {
      version: 2,
      stage_mode: 'dag' as const,
      nodes: [
        {
          id: 'legacy_stage',
          name: 'Existing stage',
          depends_on: [],
          required: true,
          workspace_policy: 'composer' as const,
        },
      ],
    }
    await api.projects.update('project-1', { version: 3, workflowDefinition: definition })
    const action = {
      type: 'decide_node' as const,
      node_id: 'legacy_stage',
      action: 'approve' as const,
      idempotency_key: 'decision-1',
    }
    await api.issues.update('issue-1', { version: 4, workflowAction: action })
    const fulfillments = [
      { requirement_id: 'acceptance_criteria', kind: 'text', text: 'Can save and reload' },
    ]
    await api.deliveries.finalize('delivery-1', {
      workflowNodeId: 'legacy_stage',
      fulfillments,
    })
    expect(client.patch).toHaveBeenNthCalledWith(1, '/v1/cloud-projects/project-1', {
      version: 3,
      workflow_definition: definition,
    })
    expect(client.patch).toHaveBeenNthCalledWith(2, '/v1/loop-items/issue-1', {
      version: 4,
      workflow_action: action,
    })
    expect(client.post).toHaveBeenCalledWith('/v1/deliveries/delivery-1/finalize', {
      workflow_node_id: 'legacy_stage',
      fulfillments,
    })
  })

  it('uses canonical member, agent, and execution environment endpoints', async () => {
    const client = createClient()
    client.post
      .mockResolvedValueOnce({
        id: 8,
        user_id: 8,
        user_name: '王芳',
        email: 'wangfang@example.com',
        role: 'Developer',
      })
      .mockResolvedValueOnce({
        id: 'team-kind-12',
        team_id: 12,
        name: 'Codex',
        owner_type: 'workspace',
        owner_id: 'workspace-1',
        owner_name: '研发空间',
        status: 'available',
        execution_environment_ids: [],
      })
      .mockResolvedValueOnce({
        id: 'device-kind-22',
        device_id: 22,
        name: 'Cloud Runner',
        kind: 'cloud_host',
        owner_type: 'user',
        owner_id: '8',
        owner_name: '王芳',
        status: 'online',
        updated_at: '2026-09-11T00:00:00Z',
      })
    client.patch.mockResolvedValueOnce({
      id: 8,
      user_id: 8,
      user_name: '王芳',
      email: 'wangfang@example.com',
      role: 'Viewer',
    })
    client.delete.mockResolvedValue(undefined)
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })

    await api.workspaces!.addMember('workspace/1', {
      userId: 8,
      role: 'Developer',
    })
    await api.workspaces!.updateMember('workspace/1', 8, {
      role: 'Viewer',
    })
    await api.workspaces!.removeMember('workspace/1', 8)
    await api.workspaces!.addAgent('workspace/1', { teamId: 12 })
    await api.workspaces!.removeAgent('workspace/1', 12)
    await expect(
      api.workspaces!.addExecutionEnvironment('workspace/1', {
        deviceId: 22,
      })
    ).resolves.toMatchObject({ device_id: 22, kind: 'cloud_host' })
    await api.workspaces!.removeExecutionEnvironment('workspace/1', 22)

    expect(client.post).toHaveBeenNthCalledWith(1, '/v1/workspaces/workspace%2F1/members', {
      user_id: 8,
      role: 'Developer',
    })
    expect(client.patch).toHaveBeenNthCalledWith(1, '/v1/workspaces/workspace%2F1/members/8', {
      role: 'Viewer',
    })
    expect(client.delete).toHaveBeenNthCalledWith(1, '/v1/workspaces/workspace%2F1/members/8')
    expect(client.post).toHaveBeenNthCalledWith(2, '/v1/workspaces/workspace%2F1/agents', {
      team_id: 12,
    })
    expect(client.delete).toHaveBeenNthCalledWith(2, '/v1/workspaces/workspace%2F1/agents/12')
    expect(client.post).toHaveBeenNthCalledWith(
      3,
      '/v1/workspaces/workspace%2F1/execution-environments',
      { device_id: 22 }
    )
    expect(client.delete).toHaveBeenNthCalledWith(
      3,
      '/v1/workspaces/workspace%2F1/execution-environments/22'
    )
  })
})
