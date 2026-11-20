import type { RuntimeWorkListResponse } from '@/types/api'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { RuntimeTaskMachine } from './runtimeTaskLifecycle/RuntimeTaskMachine'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'
import { collectRuntimeTaskReminderItems, useRuntimeTaskReminders } from './runtimeTaskReminders'
import { createRuntimeTaskReminderSource } from './runtimeTaskReminderSource'
import { defaultNotificationPreferences } from '@/features/notifications/notificationPreferences'
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

test('keeps memory review results silent with in-app and system reminders enabled', async () => {
  const send = vi.mocked(sendSystemNotification)
  send.mockClear()
  const store = new RuntimeTaskLifecycleStore('memory-review-reminder-test')
  const item = notificationItem('device-1')
  const scheduled = {
    ...item.task,
    runtimeHandle: { origin: { type: 'stand_in_schedule' } },
  }
  const review = {
    ...scheduled,
    taskId: 'memory-review',
    runtimeHandle: { origin: { type: 'stand_in_schedule', memoryReview: true } },
  }
  const work = {
    projects: [],
    chats: [{ ...item.workspace, tasks: [review, scheduled] }],
    totalTasks: 2,
  }
  const items = collectRuntimeTaskReminderItems(work)
  store.syncRuntimeWork(work)
  for (const { address } of items) {
    store.executorStarted(address)
    store.turnStarted(address, 'turn-1')
    store.turnSettled(address, 'turn-1', 'succeeded')
    store.executorSettled(address)
  }
  expect(store.getSnapshot().unreadTaskKeys).toContain(items[0].key)
  const source = createRuntimeTaskReminderSource(store)
  const stop = source.subscribe(() => {}, {
    items,
    listedItems: items,
    unreadMessageCounts: new Map(),
    notificationPreferences: {
      ...defaultNotificationPreferences,
      stand_in: { in_app: true, system: true, im: true },
    },
  })
  try {
    expect([...source.getSnapshot()]).toEqual([items[1].key])
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0]?.[0].address?.taskId).toBe(scheduled.taskId)
  } finally {
    stop()
  }
})

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
  const runtimeWorkFor = (item: RuntimeTaskReminderItem): RuntimeWorkListResponse => ({
    projects: [
      {
        project: { key: 'project-1', id: 1, name: 'Project' },
        deviceWorkspaces: [
          {
            deviceId: item.address.deviceId,
            remoteHostId: alias.address.deviceId,
            available: true,
            workspacePath: '/workspace/repo',
            tasks: [item.task],
          },
        ],
      },
    ],
    chats: [],
    totalTasks: 1,
  })
  store.syncRuntimeWork(runtimeWorkFor(alias))
  store.executorStarted(alias.address)
  store.turnStarted(alias.address, 'turn-1')
  store.turnSettled(alias.address, 'turn-1', 'succeeded')
  store.executorSettled(alias.address)
  const useReminders = (item: RuntimeTaskReminderItem) =>
    useRuntimeTaskReminders({
      runtimeWork: runtimeWorkFor(item),
      lifecycleStore: store,
      lifecycleSnapshot: store.getSnapshot(),
    })

  const { rerender } = renderHook(useReminders, { initialProps: alias })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  act(() => {
    store.syncRuntimeWork(runtimeWorkFor(canonical))
    rerender(canonical)
  })
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(send).toHaveBeenCalledTimes(1)
})
