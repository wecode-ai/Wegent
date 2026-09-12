import { describe, expect, it } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import { isRuntimeMyWorkItem, mergeRuntimeMyWorkItems, runtimeMyWorkItems } from './runtimeMyWork'

const target = {
  projectId: 'default-work-items',
  projectStore: 'backend' as const,
  createdByUserId: 7,
}

function task(overrides: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return {
    taskId: 'task-1',
    workspacePath: '/tmp/project',
    title: 'Local task',
    runtime: 'codex',
    ...overrides,
  }
}

function runtimeWork(tasks: RuntimeTaskSummary[]): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 91, key: 'project-1', name: 'Local project' },
        deviceWorkspaces: [
          {
            deviceId: 'device-1',
            workspacePath: '/tmp/project',
            available: true,
            tasks,
          },
        ],
      },
    ],
    chats: [],
    totalTasks: tasks.length,
  }
}

function issue(overrides: Partial<CloudLoopItem> = {}): CloudLoopItem {
  return {
    id: 'ISSUE-1',
    cloud_project_id: target.projectId,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 7,
    assignee_user_id: null,
    title: 'Persisted Issue',
    description: '',
    status: 'in_progress',
    priority: 'none',
    due_at: null,
    tags: [],
    sort_order: 0,
    current_delivery_id: null,
    version: 1,
    created_at: '2026-09-12T00:00:00Z',
    updated_at: '2026-09-12T00:00:00Z',
    completed_at: null,
    ...overrides,
  }
}

describe('runtimeMyWorkItems', () => {
  it('projects ordinary Runtime Tasks into the unified My Tasks board', () => {
    const [item] = runtimeMyWorkItems(runtimeWork([task()]), target)

    expect(item).toMatchObject({
      id: 'runtime:device-1:task-1',
      cloud_project_id: target.projectId,
      project_store: target.projectStore,
      local_project_id: 91,
      local_project_name: 'Local project',
      status: 'in_review',
      runtime_address: {
        deviceId: 'device-1',
        taskId: 'task-1',
        runtime: 'codex',
        workspacePath: '/tmp/project',
      },
    })
    expect(isRuntimeMyWorkItem(item)).toBe(true)
  })

  it('uses device and task identity so equal task ids from different devices are preserved', () => {
    const work = runtimeWork([task()])
    work.projects[0].deviceWorkspaces.push({
      deviceId: 'device-2',
      workspacePath: '/tmp/project',
      available: true,
      tasks: [task()],
    })

    expect(runtimeMyWorkItems(work, target).map(item => item.id)).toEqual([
      'runtime:device-1:task-1',
      'runtime:device-2:task-1',
    ])
  })

  it('uses the shared lifecycle projection for live Runtime Task status', () => {
    const work = runtimeWork([task({ running: false, status: 'done' })])
    const address = {
      deviceId: 'device-1',
      taskId: 'task-1',
      runtime: 'codex' as const,
      workspacePath: '/tmp/project',
    }
    const lifecycleStore = new RuntimeTaskLifecycleStore('runtime-my-work-test')
    lifecycleStore.syncRuntimeWork(work)
    lifecycleStore.executorStarted(address)

    const [item] = runtimeMyWorkItems(work, target, lifecycleStore.getSnapshot())

    expect(item).toMatchObject({
      status: 'in_progress',
      execution_state: 'running',
    })
  })

  it('projects successful and failed terminal states into completed and confirmation', () => {
    const items = runtimeMyWorkItems(
      runtimeWork([
        task({ taskId: 'completed', running: false, completedAt: 1_700_000_000 }),
        task({
          taskId: 'failed',
          running: false,
          status: 'failed',
          completedAt: 1_700_000_000,
        }),
      ]),
      target
    )

    expect(items.map(item => [item.runtime_address.taskId, item.status])).toEqual([
      ['completed', 'completed'],
      ['failed', 'in_review'],
    ])
  })
})

describe('mergeRuntimeMyWorkItems', () => {
  it('deduplicates a Runtime Task whose runtime handle points to a persisted Issue', () => {
    const persisted = issue()
    const [runtime] = runtimeMyWorkItems(
      runtimeWork([
        task({
          title: 'Runtime duplicate',
          runtimeHandle: {
            origin: {
              loop_item_id: persisted.id,
            },
          },
        }),
      ]),
      target
    )

    expect(mergeRuntimeMyWorkItems([persisted], [runtime])).toEqual([persisted])
  })

  it('deduplicates from the binding table even when the Runtime Task handle has no Issue id', () => {
    const persisted = issue()
    const [runtime] = runtimeMyWorkItems(runtimeWork([task()]), target)

    expect(
      mergeRuntimeMyWorkItems(
        [persisted],
        [runtime],
        [
          {
            loop_item_id: persisted.id,
            device_id: runtime.runtime_address.deviceId,
            task_id: runtime.runtime_address.taskId,
          },
        ],
        [persisted.id]
      )
    ).toEqual([persisted])
  })
})
