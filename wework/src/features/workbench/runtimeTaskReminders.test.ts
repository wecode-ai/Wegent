import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { RuntimeTaskMachine } from './runtimeTaskLifecycle/RuntimeTaskMachine'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'
import { useRuntimeTaskReminders } from './runtimeTaskReminders'
import { sendSystemNotification } from './runtimeTaskSystemNotifications'

vi.mock('@/desktop/windowFocus', () => ({
  isMainWindowFocused: () => false,
  subscribeMainWindowFocus: () => () => {},
}))
vi.mock('./runtimeTaskSystemNotifications', () => ({
  sendSystemNotification: vi.fn(),
}))

function reminderItem(key: string): RuntimeTaskReminderItem {
  return {
    key,
    address: { deviceId: 'device-1', taskId: key },
    task: {
      taskId: key,
      workspacePath: '/workspace/repo',
      title: key,
      runtime: 'codex',
    },
    workspace: {
      deviceId: 'device-1',
      available: true,
      workspacePath: '/workspace/repo',
      tasks: [],
    },
    projectName: 'Project',
  }
}

describe('getVisibleRuntimeTaskUnreadKeys', () => {
  test('discovers hidden pending work without adding it to visible unread badges', () => {
    const item = reminderItem('hidden-pending')
    const machine = new RuntimeTaskMachine(item.address)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: item.address,
      task: { ...item.task, interactionStatus: 'awaitingUserReply' },
    })
    const hidden = machine.getSnapshot()
    const store = new RuntimeTaskLifecycleStore('hidden-pending-reminder-test')
    const { result } = renderHook(() =>
      useRuntimeTaskReminders({
        runtimeWork: { projects: [], chats: [], totalTasks: 0 },
        lifecycleStore: store,
        lifecycleSnapshot: {
          version: 1,
          tasks: new Map([[hidden.key, hidden]]),
          runningTaskKeys: new Set(),
          queuedTaskKeys: new Set(),
          unreadTaskKeys: new Set([hidden.key]),
        },
      })
    )
    expect(result.current.items.map(row => row.address.taskId)).toEqual(['hidden-pending'])
    expect(result.current.unreadCount).toBe(0)
    expect(result.current.unreadTaskKeys.size).toBe(0)
  })
})

function notificationItem(deviceId: string): RuntimeTaskReminderItem {
  return {
    key: `${deviceId}\0task-1`,
    address: { deviceId, taskId: 'task-1', workspacePath: '/workspace/repo' },
    task: {
      taskId: 'task-1',
      workspacePath: '/workspace/repo',
      title: 'Task',
      runtime: 'codex',
    },
    workspace: {
      deviceId,
      available: true,
      workspacePath: '/workspace/repo',
      tasks: [],
    },
    projectName: 'Project',
  }
}

test('notifies once when an unread completion survives a device alias migration', async () => {
  localStorage.setItem(
    'wework.notification-preferences:active',
    JSON.stringify({ tasks: { in_app: true, system: true, im: null } })
  )
  const send = vi.mocked(sendSystemNotification)
  send.mockClear()
  const store = new RuntimeTaskLifecycleStore('alias-notification-test')
  const alias = notificationItem('alias-device')
  const canonical = notificationItem('canonical-device')
  const useReminders = (item: RuntimeTaskReminderItem) =>
    useRuntimeTaskReminders({
      runtimeWork: {
        projects: [
          {
            project: { key: 'project-1', id: 1, name: 'Project' },
            deviceWorkspaces: [
              {
                deviceId: item.address.deviceId,
                available: true,
                workspacePath: '/workspace/repo',
                tasks: [item.task],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
      lifecycleStore: store,
      lifecycleSnapshot: {
        version: 1,
        tasks: new Map(),
        runningTaskKeys: new Set(),
        queuedTaskKeys: new Set(),
        unreadTaskKeys: new Set([item.key]),
      },
    })

  const { rerender } = renderHook(useReminders, { initialProps: alias })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  rerender(canonical)
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(send).toHaveBeenCalledTimes(1)
})
