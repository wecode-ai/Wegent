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
      role: 'Reporter',
    })
    client.delete.mockResolvedValue(undefined)
    const api = createWebSharedWorkspaceApi(client, { getBlob: jest.fn() })

    await api.workspaces!.addMember('workspace/1', {
      userId: 8,
      role: 'Developer',
    })
    await api.workspaces!.updateMember('workspace/1', 8, {
      role: 'Reporter',
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
      role: 'Reporter',
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
