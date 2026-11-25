import type { RuntimeWorkListResponse } from '@/types/api'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import { RuntimeTaskMachine } from './runtimeTaskLifecycle/RuntimeTaskMachine'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'
import { collectRuntimeTaskReminderItems, useRuntimeTaskReminders } from './runtimeTaskReminders'
import { createRuntimeTaskReminderSource } from './runtimeTaskReminderSource'
import { defaultNotificationPreferences } from '@/features/notifications/notificationPreferences'
import { createUnlistedStandInTasksSource } from '@/features/notifications/unlistedStandInTasksSource'
import { useUnlistedStandInTasks } from '@/features/notifications/useUnlistedStandInTasks'
import { createNotificationCenterSummary } from '@/features/notifications/notificationCenterSummary'
import { readCachedRemoteRuntimeWork, writeCachedRemoteRuntimeWork } from './remoteRuntimeWorkCache'
import { serializeTaskKeys } from './runtimeTaskLifecycle/taskKeyStorage'
import { sendSystemNotification } from './runtimeTaskSystemNotifications'
import { syncNotificationUnreadCount } from '@/desktop/trayNavigation'

vi.mock('@/desktop/windowFocus', () => ({
  isMainWindowFocused: () => false,
  subscribeMainWindowFocus: () => () => {},
}))
vi.mock('./runtimeTaskSystemNotifications', () => ({
  sendSystemNotification: vi.fn(),
}))
vi.mock('@/desktop/trayNavigation', () => ({ syncNotificationUnreadCount: vi.fn() }))
vi.mock('@/desktop/localExecutor', () => ({
  requestLocalExecutor: vi.fn().mockResolvedValue({ messages: [] }),
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

describe('runtime task reminders', () => {
  test('keeps the read action stable when another task starts', () => {
    const store = new RuntimeTaskLifecycleStore('reminder-read-action-identity')
    const { result, rerender } = renderHook(
      lifecycleSnapshot =>
        useRuntimeTaskReminders({ runtimeWork: null, lifecycleStore: store, lifecycleSnapshot }),
      { initialProps: store.getSnapshot() }
    )
    const markRead = result.current.markRuntimeTaskRead

    store.executorStarted(reminderItem('other').address)
    rerender(store.getSnapshot())

    expect(result.current.hasRunningTasks).toBe(true)
    expect(result.current.markRuntimeTaskRead).toBe(markRead)
  })

  test('preserves listed reminder rows when only an unlisted task changes', () => {
    const listed = reminderItem('listed')
    const unlisted = new RuntimeTaskMachine(reminderItem('unlisted').address).getSnapshot()
    const items = [listed]
    const initial = new RuntimeTaskLifecycleStore('reminder-row-identity-test').getSnapshot()
    const { result, rerender } = renderHook(snapshot => useUnlistedStandInTasks(items, snapshot), {
      initialProps: initial,
    })
    const rows = result.current
    rerender({ ...initial, version: 1, tasks: new Map([[unlisted.key, unlisted]]) })
    expect(result.current).toBe(rows)
  })

  test('reuses unchanged listed reminder rows when one task starts a turn', () => {
    const first = new RuntimeTaskMachine(reminderItem('first-listed').address)
    const second = new RuntimeTaskMachine(reminderItem('second-listed').address)
    const firstSnapshot = first.getSnapshot()
    const secondSnapshot = second.getSnapshot()
    const items = [
      { ...reminderItem('first-listed'), key: firstSnapshot.key },
      { ...reminderItem('second-listed'), key: secondSnapshot.key },
    ]
    const initial = new RuntimeTaskLifecycleStore('listed-reminder-update-test').getSnapshot()
    const { result, rerender } = renderHook(snapshot => useUnlistedStandInTasks(items, snapshot), {
      initialProps: {
        ...initial,
        tasks: new Map([
          [firstSnapshot.key, firstSnapshot],
          [secondSnapshot.key, secondSnapshot],
        ]),
      },
    })
    const [firstRow, secondRow] = result.current
    expect(firstRow.lifecycle).toBe(firstSnapshot)
    expect(secondRow.lifecycle).toBe(secondSnapshot)

    first.dispatch({ type: 'turn_started', turnId: 'turn-1' })
    const updated = first.getSnapshot()
    rerender({
      ...initial,
      version: 1,
      tasks: new Map([
        [updated.key, updated],
        [secondSnapshot.key, secondSnapshot],
      ]),
    })

    expect(result.current[0]).not.toBe(firstRow)
    expect(result.current[0].lifecycle).toBe(updated)
    expect(result.current[1]).toBe(secondRow)
  })

  test('keeps the mark-read action stable across lifecycle updates for one store', async () => {
    const item = reminderItem('running-reminder')
    const runtimeWork = {
      projects: [],
      chats: [{ ...item.workspace, tasks: [item.task] }],
      totalTasks: 1,
    }
    const firstStore = new RuntimeTaskLifecycleStore('stable-reminder-action-test')
    firstStore.syncRuntimeWork(runtimeWork)
    const { result, rerender } = renderHook(
      ({ store }: { store: RuntimeTaskLifecycleStore }) =>
        useRuntimeTaskReminders({
          runtimeWork,
          lifecycleStore: store,
          lifecycleSnapshot: store.getSnapshot(),
        }),
      { initialProps: { store: firstStore } }
    )
    const initialAction = result.current.markRuntimeTaskRead

    await act(async () => {
      firstStore.turnStarted(item.address, 'turn-1')
      rerender({ store: firstStore })
    })
    expect(result.current.items[0].lifecycle?.turn.id).toBe('turn-1')
    expect(result.current.markRuntimeTaskRead).toBe(initialAction)

    const nextStore = new RuntimeTaskLifecycleStore('new-reminder-action-test')
    const markRead = vi.spyOn(nextStore, 'markRead')
    await act(async () => rerender({ store: nextStore }))
    expect(result.current.markRuntimeTaskRead).not.toBe(initialAction)
    await act(async () => result.current.markRuntimeTaskRead(item.address))
    expect(markRead).toHaveBeenCalledWith(item.address)
  })

  test('discovers hidden stand-in work from task metadata without loading its transcript', async () => {
    const hidden = reminderItem('hidden-stand-in')
    const ordinary = reminderItem('hidden-ordinary')
    const task = { ...hidden.task, runtimeHandle: { origin: { initiatedBy: 'stand_in' } } }
    const readTask = vi.fn(async (_deviceId: string, taskId: string) => ({
      success: true,
      task: taskId === hidden.address.taskId ? task : ordinary.task,
    }))
    const source = createUnlistedStandInTasksSource({ readTask })
    const stop = source.subscribe(vi.fn(), [
      { key: hidden.key, address: hidden.address, signature: '1' },
      { key: ordinary.key, address: ordinary.address, signature: '1' },
    ])
    try {
      await waitFor(() => expect(source.getSnapshot().get(hidden.key)?.task).toBe(task))
      expect(source.getSnapshot().has(ordinary.key)).toBe(false)
    } finally {
      stop()
    }
  })

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

test.each(['task list', 'executor snapshot', 'earlier running snapshot'])(
  'keeps memory review results silent when the origin is available in the %s',
  async originSource => {
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
    const reported = {
      ...scheduled,
      taskId: 'reported-by-assistant',
      runtimeHandle: {
        ...scheduled.runtimeHandle,
        executionRequest: { standInReportTo: { userId: 7, taskId: 'stand-in-chat-7-primary' } },
      },
    }
    const work = {
      projects: [],
      chats: [
        {
          ...item.workspace,
          tasks: [
            originSource === 'task list' ? review : { ...review, runtimeHandle: undefined },
            scheduled,
            reported,
          ],
        },
      ],
      totalTasks: 3,
    }
    const items = collectRuntimeTaskReminderItems(work)
    store.syncRuntimeWork(work)
    if (originSource === 'earlier running snapshot') {
      store.syncRuntimeTask(items[0].address, { ...review, running: true, updatedAt: 1000 })
      store.syncRuntimeWork({
        ...work,
        chats: [
          {
            ...work.chats[0],
            tasks: [
              {
                ...items[0].task,
                running: false,
                status: 'completed',
                completedAt: 2000,
                updatedAt: 2000,
              },
              scheduled,
              reported,
            ],
          },
        ],
      })
    } else if (originSource === 'executor snapshot') {
      store.syncRuntimeTask(items[0].address, review)
    }
    const settlingItems = originSource === 'earlier running snapshot' ? items.slice(1) : items
    for (const { address } of settlingItems) {
      store.executorStarted(address)
      store.turnStarted(address, 'turn-1')
      store.turnSettled(address, 'turn-1', 'succeeded')
      store.executorSettled(address)
    }
    expect([...store.getSnapshot().unreadTaskKeys]).toEqual([items[1].key, items[2].key])
    const source = createRuntimeTaskReminderSource(store)
    const stop = source.subscribe(() => {}, {
      items,
      listedItems: items,
      unreadMessageCounts: new Map(),
      notificationPreferences: {
        ...defaultNotificationPreferences,
        tasks: { in_app: true, system: true, im: null },
        stand_in: { in_app: true, system: true, im: true },
      },
    })
    try {
      await waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            address: expect.objectContaining({ taskId: scheduled.taskId }),
          })
        )
      )
      expect(send.mock.calls.map(([notification]) => notification.address?.taskId)).toEqual([
        scheduled.taskId,
      ])
      expect([...source.getSnapshot()]).toEqual([items[1].key, items[2].key])
    } finally {
      stop()
    }
  }
)

test('excludes an existing memory review unread marker when restoring cached remote work', async () => {
  const owner = 'cached-memory-review-reminder-test'
  const item = notificationItem('remote-device')
  const review = {
    ...item.task,
    taskId: 'memory-review',
    runtimeHandle: { origin: { type: 'stand_in_schedule', memoryReview: true, userId: 7 } },
  }
  const work = {
    projects: [],
    chats: [{ ...item.workspace, tasks: [review, item.task] }],
    totalTasks: 2,
  }
  const unreadStorageKey = `wework.runtimeTaskLifecycle.${owner}.unread.v2`
  localStorage.setItem(
    unreadStorageKey,
    serializeTaskKeys(collectRuntimeTaskReminderItems(work).map(({ key }) => key))
  )
  writeCachedRemoteRuntimeWork(owner, work)
  const cachedWork = readCachedRemoteRuntimeWork(owner)
  expect(cachedWork.chats[0]?.tasks[0]?.runtimeHandle).toEqual({
    origin: { type: 'stand_in_schedule', memoryReview: true },
  })
  const store = new RuntimeTaskLifecycleStore(owner)
  store.syncRuntimeWork(cachedWork)
  const { result, unmount } = renderHook(() =>
    useRuntimeTaskReminders({
      runtimeWork: cachedWork,
      lifecycleStore: store,
      lifecycleSnapshot: store.getSnapshot(),
    })
  )
  const bell = createNotificationCenterSummary()
  const stop = bell.subscribe(() => {}, {
    taskSource: result.current,
    collaborationUnreadCount: 0,
    generalInbox: null,
  })
  try {
    expect(bell.getSnapshot().unreadCount).toBe(1)
    expect(bell.getSnapshot().unreadTasks.map(({ task }) => task.taskId)).toEqual([
      item.task.taskId,
    ])
    expect(localStorage.getItem(unreadStorageKey)).toBe(serializeTaskKeys([item.key]))
  } finally {
    stop()
    unmount()
    await act(async () => {})
  }
})

test('keeps the notification summary and native badge stable across read task updates', async () => {
  const badge = vi.mocked(syncNotificationUnreadCount)
  badge.mockClear()
  const bell = createNotificationCenterSummary()
  const input = {
    taskSource: null,
    collaborationUnreadCount: 0,
    generalInbox: null,
  }
  const listener = vi.fn()
  const stop = bell.subscribe(listener, input)
  const snapshot = bell.getSnapshot()
  stop()

  const item = reminderItem('read-task')
  const taskSource = {
    items: [item],
    unreadTaskKeys: new Set<string>(),
    markRuntimeTaskRead: vi.fn(),
  }
  const stopRead = bell.subscribe(listener, { ...input, taskSource })
  expect(bell.getSnapshot()).toBe(snapshot)
  expect(listener).not.toHaveBeenCalled()
  expect(badge.mock.calls).toEqual([[0]])
  stopRead()

  const stopUnread = bell.subscribe(listener, {
    ...input,
    taskSource: { ...taskSource, unreadTaskKeys: new Set([item.key]) },
  })
  expect(bell.getSnapshot().sortedTasks).toEqual([item])
  expect(listener).toHaveBeenCalledTimes(1)
  expect(badge.mock.calls).toEqual([[0], [1]])
  stopUnread()
  await act(async () => {})
  expect(badge.mock.calls).toEqual([[0], [1], [0]])
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

  const { rerender, unmount } = renderHook(useReminders, { initialProps: alias })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  act(() => {
    store.syncRuntimeWork(runtimeWorkFor(canonical))
    rerender(canonical)
  })
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(send).toHaveBeenCalledTimes(1)
  unmount()

  const restarted = new RuntimeTaskLifecycleStore('alias-notification-test')
  restarted.syncRuntimeWork(runtimeWorkFor(canonical))
  const { result } = renderHook(() =>
    useRuntimeTaskReminders({
      runtimeWork: runtimeWorkFor(canonical),
      lifecycleStore: restarted,
      lifecycleSnapshot: restarted.getSnapshot(),
    })
  )
  expect(result.current.unreadCount).toBe(1)
  await act(async () => {})
  expect(send).toHaveBeenCalledTimes(1)
})
