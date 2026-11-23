import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConversationTurn } from '@/types/workbench'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle'
import { useStandInMessageReminders } from './useStandInMessageReminders'
import { defaultNotificationPreferences } from '@/features/notifications/notificationPreferences'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'

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
