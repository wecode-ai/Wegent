import { act, render, renderHook } from '@testing-library/react'
import { startTransition, Suspense } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConversationTurn } from '@/types/workbench'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { useStandInMessageReminders } from './useStandInMessageReminders'
import { defaultNotificationPreferences } from '@/features/notifications/notificationPreferences'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'
import { useUnlistedStandInTasks } from '@/features/notifications/useUnlistedStandInTasks'

const mock = vi.hoisted(() => ({
  turns: [] as RuntimeConversationTurn[],
  listeners: new Set<() => void>(),
  send: vi.fn(),
}))
vi.mock('./runtimeConversationCache', () => ({
  getRuntimeConversationTurns: () => mock.turns,
  subscribeRuntimeConversation: (_address: unknown, callback: () => void) => {
    mock.listeners.add(callback)
    return () => mock.listeners.delete(callback)
  },
}))
vi.mock('./runtimeTaskSystemNotifications', () => ({ sendSystemNotification: mock.send }))
vi.mock('@/i18n', () => ({ default: { t: () => '我的助理' } }))
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  mock.turns = []
  mock.listeners.clear()
  mock.send.mockClear()
})

describe('stand-in message notification source', () => {
  it('preserves the committed subscription when a different identity render is suspended and abandoned', async () => {
    const store = new RuntimeTaskLifecycleStore('notification-interrupted-render-test')
    const receiptsSubscribe = vi.spyOn(store.messageReceipts, 'subscribe')
    const address = { deviceId: 'device', taskId: 'stand-in-chat-7-role' }
    const item: RuntimeTaskReminderItem = {
      key: `${address.deviceId}\0${address.taskId}`,
      address,
      projectName: '',
      workspace: { deviceId: 'device', available: true, workspacePath: '', tasks: [] },
      task: {
        taskId: address.taskId,
        title: '开发助理',
        runtime: 'codex',
        workspacePath: '',
        runtimeHandle: { origin: { type: 'stand_in_identity', standInId: 'developer' } },
      },
    }
    store.syncRuntimeTask(address, item.task)
    let release!: () => void
    const blocker = new Promise<void>(resolve => {
      release = resolve
    })
    const suspended = vi.fn()
    function Probe({ row, suspend }: { row: RuntimeTaskReminderItem; suspend: boolean }) {
      useStandInMessageReminders([row], store, defaultNotificationPreferences)
      if (suspend) {
        suspended()
        throw blocker
      }
      return <span>{row.task.title}</span>
    }
    const tree = (row: RuntimeTaskReminderItem, suspend = false) => (
      <Suspense fallback={<span>waiting</span>}>
        <Probe row={row} suspend={suspend} />
      </Suspense>
    )
    const view = render(tree(item))
    const initialListener = [...mock.listeners][0]
    try {
      act(() =>
        startTransition(() =>
          view.rerender(tree({ ...item, task: { ...item.task, title: '未提交' } }, true))
        )
      )
      expect(suspended).toHaveBeenCalled()
      expect(view.getByText(item.task.title)).toBeVisible()
      view.rerender(tree({ ...item }))
      expect([...mock.listeners]).toEqual([initialListener])
      expect(receiptsSubscribe).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      await act(async () => release())
    }
  })

  it('keeps subscriptions stable on unrelated lifecycle updates and observes real identity changes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const store = new RuntimeTaskLifecycleStore('notification-identity-test')
    const receiptsSubscribe = vi.spyOn(store.messageReceipts, 'subscribe')
    const address = { deviceId: 'device', taskId: 'stand-in-chat-7-role' }
    const key = `${address.deviceId}\0${address.taskId}`
    const item: RuntimeTaskReminderItem = {
      key,
      address,
      projectName: '',
      workspace: { deviceId: 'device', available: true, workspacePath: '', tasks: [] },
      task: {
        taskId: address.taskId,
        title: '开发助理',
        runtime: 'codex',
        workspacePath: '',
        runtimeHandle: { origin: { type: 'stand_in_identity', standInId: 'developer' } },
      },
    }
    const ordinary: RuntimeTaskReminderItem = {
      ...item,
      key: 'device\0ordinary',
      address: { deviceId: 'device', taskId: 'ordinary' },
      task: { ...item.task, taskId: 'ordinary', runtimeHandle: undefined },
    }
    store.syncRuntimeTask(ordinary.address, ordinary.task)
    const hook = renderHook(
      (items: RuntimeTaskReminderItem[]) =>
        useStandInMessageReminders(
          useUnlistedStandInTasks(items, store.getSnapshot()),
          store,
          defaultNotificationPreferences
        ),
      { initialProps: [ordinary] }
    )
    const empty = hook.result.current
    act(() => store.executorStarted(ordinary.address))
    hook.rerender([ordinary])
    expect(hook.result.current).toBe(empty)
    expect(receiptsSubscribe).toHaveBeenCalledTimes(1)

    store.syncRuntimeTask(address, item.task)
    hook.rerender([ordinary, item])
    const initialListener = [...mock.listeners][0]
    const counts = hook.result.current
    act(() => store.executorSettled(ordinary.address))
    hook.rerender([ordinary, { ...item }])
    expect(hook.result.current).toBe(counts)
    expect([...mock.listeners]).toEqual([initialListener])
    expect(receiptsSubscribe).toHaveBeenCalledTimes(2)

    const finish = (id: string, completedAt: number) => {
      act(() => {
        mock.turns.push({
          id,
          status: 'done',
          completedAt,
          items: [
            {
              id: `${id}-reply`,
              type: 'assistant_text',
              content: id,
              createdAt: new Date(completedAt).toISOString(),
            },
          ],
        })
        mock.listeners.forEach(listener => listener())
      })
    }
    finish('first', 1200)
    expect(hook.result.current.get(key)).toBe(1)
    expect(mock.send).toHaveBeenCalledExactlyOnceWith({ title: '开发助理', body: 'first', address })

    const renamed = {
      ...item,
      address: { ...address, workspacePath: '/workspace/renamed', threadId: 'thread' },
      task: { ...item.task, title: '新的助理' },
    }
    store.syncRuntimeTask(renamed.address, renamed.task)
    hook.rerender([ordinary, renamed])
    expect(mock.listeners.has(initialListener)).toBe(false)
    finish('second', 1300)
    expect(hook.result.current.get(key)).toBe(2)
    expect(mock.send).toHaveBeenLastCalledWith({
      title: '新的助理',
      body: 'second',
      address: renamed.address,
    })
    expect(mock.send).toHaveBeenCalledTimes(2)

    const renamedListener = [...mock.listeners][0]
    act(() => {
      store.executorStarted(renamed.address)
      store.turnStarted(renamed.address, 'second')
      store.turnSettled(renamed.address, 'second')
      store.executorSettled(renamed.address)
    })
    expect(store.getTask(renamed.address)?.unread).toBe(true)
    hook.rerender([ordinary, renamed])
    expect(mock.listeners.has(renamedListener)).toBe(false)
    expect(mock.send).toHaveBeenCalledTimes(2)
    act(() => store.markRead(renamed.address))
    expect(hook.result.current.get(key)).toBe(0)
    hook.unmount()
    expect(mock.listeners.size).toBe(0)
  })

  it('sends one notification for each independent completed turn in the same conversation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const store = new RuntimeTaskLifecycleStore('notification-test')
    const address = { deviceId: 'device', taskId: 'stand-in-chat-7-primary' }
    const key = `${address.deviceId}\0${address.taskId}`
    const item: RuntimeTaskReminderItem = {
      key,
      address,
      projectName: '',
      workspace: { deviceId: 'device', available: true, workspacePath: '', tasks: [] },
      task: {
        taskId: address.taskId,
        title: '我的助理',
        runtime: 'codex',
        workspacePath: '',
        runtimeHandle: { origin: { type: 'stand_in_identity' } },
      },
    }
    const items = [item]
    const hook = renderHook(() =>
      useStandInMessageReminders(items, store, defaultNotificationPreferences)
    )
    act(() => {
      mock.turns = ['first', 'second'].map((id, index) => ({
        id,
        status: 'done',
        completedAt: 1200 + index,
        items: [
          {
            id: `${id}-message`,
            type: 'assistant_text',
            content: `${id} outcome`,
            createdAt: new Date(1100 + index).toISOString(),
          },
        ],
      }))
      mock.listeners.forEach(listener => listener())
    })
    expect(hook.result.current.get(key)).toBe(2)
    expect(mock.send).toHaveBeenCalledTimes(2)
    act(() => mock.listeners.forEach(listener => listener()))
    expect(mock.send).toHaveBeenCalledTimes(2)
    act(() => store.markRead(address))
    expect(hook.result.current.get(key)).toBe(0)
    hook.unmount()
    expect(mock.listeners.size).toBe(0)
  })

  it.each(['streaming', 'running'] as const)(
    'counts an acknowledgement while %s and only notifies the final reply as the assistant',
    status => {
      vi.spyOn(Date, 'now').mockReturnValue(1000)
      const store = new RuntimeTaskLifecycleStore('native-wait-test')
      const address = { deviceId: 'device', taskId: 'stand-in-chat-7-primary' }
      const key = `${address.deviceId}\0${address.taskId}`
      const items: RuntimeTaskReminderItem[] = [
        {
          key,
          address,
          projectName: '',
          workspace: { deviceId: 'device', available: true, workspacePath: '', tasks: [] },
          task: {
            taskId: address.taskId,
            title: '我的分身',
            runtime: 'codex',
            workspacePath: '',
            runtimeHandle: { origin: { type: 'stand_in_identity' } },
          },
        },
      ]
      const hook = renderHook(() =>
        useStandInMessageReminders(items, store, defaultNotificationPreferences)
      )
      const acknowledgement = {
        id: 'ack',
        type: 'assistant_text' as const,
        content: '已交给子代理',
        createdAt: new Date(1100).toISOString(),
      }
      act(() => {
        mock.turns = [{ id: 'turn', status, items: [acknowledgement] }]
        mock.listeners.forEach(listener => listener())
      })
      expect(hook.result.current.get(key)).toBe(0)
      act(() => {
        mock.turns[0].items.push({
          id: 'child',
          type: 'block',
          block: {
            id: 'child',
            subtaskId: 'turn',
            type: 'subagent',
            status: 'done',
            createdAt: 1200,
            title: '后台子代理',
          },
        })
        mock.listeners.forEach(listener => listener())
      })
      expect(hook.result.current.get(key)).toBe(1)
      expect(mock.send).not.toHaveBeenCalled()
      act(() => {
        mock.turns[0].items.push({
          ...acknowledgement,
          id: 'result',
          content: '检查完成',
          createdAt: new Date(1300).toISOString(),
        })
        mock.listeners.forEach(listener => listener())
      })
      expect(hook.result.current.get(key)).toBe(1)
      act(() => {
        const child = mock.turns[0].items[1]
        mock.turns[0].items.push({ ...child, id: 'child-follow-up' })
        mock.listeners.forEach(listener => listener())
      })
      expect(hook.result.current.get(key)).toBe(2)
      expect(mock.send).not.toHaveBeenCalled()
      act(() => {
        mock.turns[0].status = 'done'
        mock.turns[0].completedAt = 1400
        mock.listeners.forEach(listener => listener())
      })
      expect(hook.result.current.get(key)).toBe(2)
      expect(mock.send).toHaveBeenCalledExactlyOnceWith({
        title: '我的助理',
        body: '检查完成',
        address,
      })
      act(() => {
        mock.turns[0].items.push({
          ...acknowledgement,
          id: 'late-transcript-text',
          content: '补充说明',
          createdAt: new Date(1400).toISOString(),
        })
        mock.listeners.forEach(listener => listener())
      })
      expect(mock.send).toHaveBeenCalledTimes(1)
    }
  )
})
