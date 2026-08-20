import { describe, expect, it } from 'vitest'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import { runtimeMyWorkItems } from './runtimeMyWork'

function task(overrides: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return {
    taskId: 'task-1',
    workspacePath: '/tmp/project',
    title: 'Local task',
    runtime: 'codex',
    ...overrides,
  }
}

function runtimeWork(
  tasks: RuntimeTaskSummary[],
  workspaceOverrides: Partial<
    RuntimeWorkListResponse['projects'][number]['deviceWorkspaces'][number]
  > = {}
): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { key: 'project-1', name: 'Local project' },
        deviceWorkspaces: [
          {
            deviceId: 'device-1',
            workspacePath: '/tmp/project',
            available: true,
            tasks,
            ...workspaceOverrides,
          },
        ],
      },
    ],
    chats: [],
    totalTasks: tasks.length,
  }
}

describe('runtimeMyWorkItems', () => {
  it('includes unbound local runtime tasks automatically', () => {
    const [item] = runtimeMyWorkItems(runtimeWork([task()]))

    expect(item).toMatchObject({
      id: 'task-1',
      cloud_project_id: 'runtime:project-1',
      project_name: 'Local project',
      status: 'pending',
      runtime_address: {
        deviceId: 'device-1',
        taskId: 'task-1',
      },
    })
  })

  it('keeps every offline cloud-associated task in My Tasks', () => {
    const [item] = runtimeMyWorkItems(
      runtimeWork(
        [
          task({
            runtimeHandle: { cloudProjectId: 'cloud-1', loopItemId: 'WEG-1' },
          }),
        ],
        {
          available: false,
          deviceStatus: 'offline',
        }
      )
    )

    expect(item.cloud_project_id).toBe('cloud-1')
    expect(item.runtime_address.runtimeHandle).toMatchObject({ loopItemId: 'WEG-1' })
  })

  it('maps queued, running, failed, and completed tasks into board groups', () => {
    const items = runtimeMyWorkItems(
      runtimeWork([
        task({ taskId: 'queued', running: false, status: 'queued' }),
        task({ taskId: 'running', running: true, turnStatus: 'inProgress' }),
        task({ taskId: 'failed', running: false, status: 'failed', completedAt: 1_700_000_000 }),
        task({ taskId: 'done', running: false, completedAt: 1_700_000_000 }),
      ])
    )

    expect(items.map(item => [item.id, item.status, item.has_active_task])).toEqual([
      ['queued', 'pending', false],
      ['running', 'in_progress', true],
      ['failed', 'pending', false],
      ['done', 'completed', false],
    ])
  })
})
