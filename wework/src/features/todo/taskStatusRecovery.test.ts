import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudLoopItem, LoopItemTaskBinding } from '@/api/deliveries'
import {
  requestBoardTaskStatusRecovery,
  resetTaskStatusRecoveryLeasesForTests,
  staleRuntimeTaskBatches,
} from './taskStatusRecovery'

const NOW = Date.parse('2026-08-24T13:00:00Z')

function item(
  id: string,
  deviceId: string,
  taskId: string,
  updatedAt: string,
  taskStatus: string | null = 'running',
  nodeStatus = 'running'
): CloudLoopItem {
  return {
    id,
    updated_at: updatedAt,
    workflow: {
      nodes: [
        {
          id: 'stage-1',
          status: nodeStatus,
          task_statuses: taskStatus === null ? {} : { [`${deviceId}:${taskId}`]: taskStatus },
        },
      ],
    },
  } as CloudLoopItem
}

function binding(
  itemId: string,
  deviceId: string,
  taskId: string,
  linkedAt = '2026-08-24T12:00:00Z'
): LoopItemTaskBinding {
  return {
    loop_item_id: itemId,
    device_id: deviceId,
    task_id: taskId,
    workflow_node_id: 'stage-1',
    linked_at: linkedAt,
  } as LoopItemTaskBinding
}

describe('board task status recovery', () => {
  beforeEach(() => resetTaskStatusRecoveryLeasesForTests())

  it('groups stale running tasks into one request per Runtime device', () => {
    const items = [
      item('issue-1', 'device-a', 'task-1', '2026-08-24T12:00:00Z'),
      item('issue-2', 'device-a', 'task-2', '2026-08-24T12:10:00Z'),
      item('issue-3', 'device-b', 'task-3', '2026-08-24T12:20:00Z'),
      item('issue-fresh', 'device-c', 'task-4', '2026-08-24T12:45:00Z'),
    ]
    const bindings = [
      binding('issue-1', 'device-a', 'task-1'),
      binding('issue-2', 'device-a', 'task-2'),
      binding('issue-3', 'device-b', 'task-3'),
      binding('issue-fresh', 'device-c', 'task-4'),
    ]

    expect(staleRuntimeTaskBatches(items, bindings, NOW)).toEqual([
      { deviceId: 'device-a', taskIds: ['task-1', 'task-2'] },
      { deviceId: 'device-b', taskIds: ['task-3'] },
    ])
  })

  it('requires the binding to target a workflow node on the same item', () => {
    expect(
      staleRuntimeTaskBatches(
        [item('issue-1', 'device-a', 'current-task', '2026-08-24T12:00:00Z')],
        [binding('other-issue', 'device-a', 'current-task')],
        NOW
      )
    ).toEqual([])
  })

  it('replays an old bound task whose runtime status was never projected', () => {
    expect(
      staleRuntimeTaskBatches(
        [item('issue-1', 'device-a', 'task-1', '2026-08-24T12:59:00Z', null)],
        [binding('issue-1', 'device-a', 'task-1')],
        NOW
      )
    ).toEqual([{ deviceId: 'device-a', taskIds: ['task-1'] }])
  })

  it('singleflights repeated board opens per project and device', async () => {
    const replayRuntimeTaskStatuses = vi.fn().mockResolvedValue({
      success: true,
      replayedTaskIds: ['task-1'],
      missingTaskIds: [],
    })
    const input = {
      api: { replayRuntimeTaskStatuses },
      projectKey: 'cloud:7',
      items: [item('issue-1', 'device-a', 'task-1', '2026-08-24T12:00:00Z')],
      bindings: [binding('issue-1', 'device-a', 'task-1')],
      now: NOW,
    }

    await Promise.all([
      requestBoardTaskStatusRecovery(input),
      requestBoardTaskStatusRecovery(input),
    ])

    expect(replayRuntimeTaskStatuses).toHaveBeenCalledTimes(1)
  })
})
