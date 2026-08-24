import { describe, expect, it } from 'vitest'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
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
      status: 'in_review',
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
      ['failed', 'in_review', false],
      ['done', 'completed', false],
    ])
  })

  it('uses the shared lifecycle state that drives the sidebar running indicator', () => {
    const work = runtimeWork([task({ running: false, status: 'done' })])
    const address = {
      deviceId: 'device-1',
      taskId: 'task-1',
      runtime: 'codex' as const,
      workspacePath: '/tmp/project',
    }
    const lifecycleStore = new RuntimeTaskLifecycleStore('my-work-test')
    lifecycleStore.syncRuntimeWork(work)
    lifecycleStore.executorStarted(address)

    const [item] = runtimeMyWorkItems(work, lifecycleStore.getSnapshot())

    expect(item).toMatchObject({
      id: 'task-1',
      status: 'in_progress',
      has_active_task: true,
      execution_state: 'running',
    })
  })

  it('moves stopped tasks into confirmation instead of back to the queue', () => {
    const [item] = runtimeMyWorkItems(
      runtimeWork([
        task({
          running: false,
          status: 'cancelled',
          turnStatus: 'interrupted',
        }),
      ])
    )

    expect(item.status).toBe('in_review')
  })
})
