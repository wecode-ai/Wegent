import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { useStandInNotifications } from './useStandInNotifications'
import { assignment, runtimeItem } from './standInNotifications.fixtures'

const { send } = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: () => 'main' }))
vi.mock('@/desktop/windowFocus', () => ({ isMainWindowFocused: () => true }))
vi.mock('@/features/workbench/runtimeTaskSystemNotifications', () => ({
  sendSystemNotification: send,
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const markRuntimeTaskRead = vi.fn()
const inbox = { items: [assignment], unread_count: 0, next_offset: null }
function source(item: RuntimeTaskReminderItem, unread = false) {
  return { items: [item], unreadTaskKeys: new Set(unread ? [item.key] : []), markRuntimeTaskRead }
}
function completed(time = '2026-10-21T12:04:00Z'): RuntimeTaskReminderItem {
  return {
    ...runtimeItem,
    task: {
      ...runtimeItem.task,
      running: false,
      status: 'done',
      completedAt: time,
      updatedAt: time,
    },
  }
}
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('stand-in notification read and delivery state', () => {
  it('updates the same notification on completion and preserves read state across reloads', () => {
    const hook = renderHook(
      ({ item }) => useStandInNotifications(inbox, source(item), 'user', true, true),
      { initialProps: { item: runtimeItem } }
    )
    expect(hook.result.current.unreadCount).toBe(0)
    hook.rerender({ item: completed() })
    expect(hook.result.current.items).toHaveLength(1)
    expect(hook.result.current.unreadCount).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      title: 'Review',
      body: 'notifications.stand_in_completed',
      address: runtimeItem.address,
      url: assignment.url,
    })
    act(() => hook.result.current.markRead(hook.result.current.items))
    expect(hook.result.current.unreadCount).toBe(0)
    hook.unmount()
    const reloaded = renderHook(() =>
      useStandInNotifications(inbox, source(completed()), 'user', true, true)
    )
    expect(reloaded.result.current.unreadCount).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
    reloaded.unmount()
  })
  it('does not notify historical completions again after auxiliary records were expired', () => {
    const hook = renderHook(() =>
      useStandInNotifications(inbox, source(completed()), 'user', true, true)
    )
    expect(hook.result.current.unreadCount).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
  it('marks a new pending question unread and suppresses duplicate delivery', () => {
    const waiting = {
      ...runtimeItem,
      task: { ...runtimeItem.task, interactionStatus: 'waitingForUserInput' as const },
    }
    const hook = renderHook(
      ({ item }) => useStandInNotifications(inbox, source(item), 'user', true, true),
      { initialProps: { item: runtimeItem } }
    )
    hook.rerender({ item: waiting })
    expect(hook.result.current.unreadCount).toBe(1)
    hook.rerender({ item: { ...waiting } })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('respects collaboration channel preferences independently of task reminders', () => {
    const hook = renderHook(() =>
      useStandInNotifications(inbox, source(completed(), true), 'user', true, false)
    )
    expect(hook.result.current.unreadCount).toBe(1)
    expect(send).not.toHaveBeenCalled()
    hook.unmount()
    const disabled = renderHook(() =>
      useStandInNotifications(inbox, source(completed(), true), 'user', false, false)
    )
    expect(disabled.result.current.items[0].payload.standIn).toBeUndefined()
  })
  it('does not send desktop alerts while the same execution is visible', () => {
    const visible = { ...source(completed(), true), currentAddress: runtimeItem.address }
    renderHook(() => useStandInNotifications(inbox, visible, 'user', true, true))
    expect(send).not.toHaveBeenCalled()
  })
  it('remains bounded when more than 1000 executions are available', () => {
    const items = Array.from({ length: 1005 }, (_, index) => ({
      ...completed(),
      key: `device\0task-${index}`,
      address: { deviceId: 'device', taskId: `task-${index}` },
      task: {
        ...completed().task,
        taskId: `task-${index}`,
        runtimeHandle: {
          origin: {
            ...(runtimeItem.task.runtimeHandle!.origin as object),
            humanAssignmentId: `human-${index}`,
          },
        },
      },
    }))
    const runtimeSource = { items, unreadTaskKeys: new Set<string>(), markRuntimeTaskRead }
    const hook = renderHook(() => useStandInNotifications(null, runtimeSource, 'user', true, true))
    expect(hook.result.current.items).toHaveLength(1005)
    expect(
      Object.keys(JSON.parse(localStorage.getItem('wework.stand-in-notifications:user')!))
    ).toHaveLength(1000)
    expect(send).not.toHaveBeenCalled()
  })
})
