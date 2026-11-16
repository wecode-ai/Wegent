import { describe, expect, it } from 'vitest'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/runtime'
import { conversationPinTarget } from './conversationActions'

const address = { deviceId: 'executor', taskId: 'task' }
function work(task: Partial<RuntimeTaskSummary> = {}): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 1, key: 'project', name: 'Project', stateDeviceId: 'state-owner' },
        deviceWorkspaces: [
          {
            deviceId: 'executor',
            deviceName: 'Executor',
            deviceStatus: 'online',
            available: true,
            workspacePath: '/repo',
            tasks: [
              { taskId: 'task', runtime: 'codex', title: 'Title', workspacePath: '/repo', ...task },
            ],
          },
        ],
      },
    ],
    chats: [],
    totalTasks: 1,
  }
}

describe('conversation pin identity follows PC cloud-device sidebar', () => {
  it('uses the explicit runtime thread and project state owner', () => {
    expect(conversationPinTarget(work({ threadId: ' thread ', pinned: true }), address)).toEqual({
      deviceId: 'state-owner',
      threadId: 'thread',
      pinned: true,
    })
  })
  it('preserves runtime handles received from the device', () => {
    expect(
      conversationPinTarget(
        work({ runtime: 'claude', runtimeHandle: { thread_id: 'handle' } }),
        address
      )?.threadId
    ).toBe('handle')
  })
  it('uses the task ID only for persisted Codex tasks', () => {
    expect(conversationPinTarget(work(), address)?.threadId).toBe('task')
    expect(conversationPinTarget(work({ optimistic: true }), address)).toBeNull()
    expect(conversationPinTarget(work({ runtime: 'claude' }), address)).toBeNull()
  })
  it('does not use a same-ID task belonging to another executor', () => {
    expect(conversationPinTarget(work(), { ...address, deviceId: 'other' })).toBeNull()
  })
})
