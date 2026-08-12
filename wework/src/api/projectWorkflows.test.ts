import { describe, expect, it, vi } from 'vitest'
import type { HttpClient } from './http'
import { createProjectWorkflowApi } from './projectWorkflows'

describe('createProjectWorkflowApi', () => {
  it('uses project workflow definition and task run endpoints', async () => {
    const client = {
      get: vi.fn().mockResolvedValue([]),
      post: vi.fn().mockResolvedValue({ id: 'created' }),
      patch: vi.fn().mockResolvedValue({ id: 'updated' }),
      put: vi.fn().mockResolvedValue({ id: 1 }),
    } as unknown as HttpClient
    const api = createProjectWorkflowApi(client)

    await api.createSquad('12', {
      name: '开发小队',
      leaderAgentId: 'agent-1',
      memberAgentIds: ['agent-1'],
      routingInstructions: '',
      maxParallelMembers: 1,
    })
    await api.createRepository('12', {
      provider: 'github',
      repositoryIdentity: 'wegent/wegent',
      repositoryUrl: 'https://github.com/wegent/wegent.git',
      defaultBranch: 'main',
      workspacePolicy: {},
      gitPolicy: {},
      providerSettings: {},
    })
    await api.startRun('12', 'item-1', 'run-once')
    await api.approveStage('12', 'item-1', 'run-1', 'stage-1', 3, 'looks good')
    await api.createAutomation('12', {
      name: 'Nightly',
      description: '',
      triggerType: 'cron',
      triggerConfig: { expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
      workflowId: 'workflow-1',
      executionTarget: { type: 'managed_container' },
      workspaceMode: 'git_worktree',
      taskTemplate: { title: 'Nightly task' },
      payloadMapping: {},
      enabled: true,
    })
    await api.runAutomation('12', 'automation-1', { idempotencyKey: 'run-now' })

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/v1/cloud-projects/12/agent-squads',
      expect.objectContaining({ leaderAgentId: 'agent-1' })
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/v1/cloud-projects/12/repositories',
      expect.objectContaining({ repositoryIdentity: 'wegent/wegent' })
    )
    expect(client.post).toHaveBeenNthCalledWith(
      3,
      '/v1/cloud-projects/12/loop-items/item-1/workflow/start',
      { idempotencyKey: 'run-once' }
    )
    expect(client.post).toHaveBeenNthCalledWith(
      4,
      '/v1/cloud-projects/12/loop-items/item-1/workflow/runs/run-1/stages/stage-1/approve',
      { version: 3, reason: 'looks good' }
    )
    expect(client.post).toHaveBeenNthCalledWith(
      5,
      '/v1/cloud-projects/12/workflow-automations',
      expect.objectContaining({ workflowId: 'workflow-1', triggerType: 'cron' })
    )
    expect(client.post).toHaveBeenNthCalledWith(
      6,
      '/v1/cloud-projects/12/workflow-automations/automation-1/run',
      { idempotencyKey: 'run-now' }
    )
  })
})
