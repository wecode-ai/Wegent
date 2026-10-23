import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { useStandInNotifications } from './useStandInNotifications'
import { assignment, runtimeItem } from './standInNotifications.fixtures'
import { RuntimeTaskMachine } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskMachine'

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
  it('does not replay an unread historical completion when tasks are restored', () => {
    const hook = renderHook(
      ({ loaded }) =>
        useStandInNotifications(
          inbox,
          loaded ? source(completed(), true) : null,
          'user',
          true,
          true
        ),
      { initialProps: { loaded: false } }
    )
    hook.rerender({ loaded: true })
    expect(hook.result.current.unreadCount).toBe(1)
    expect(send).not.toHaveBeenCalled()
    hook.unmount()
    renderHook(() => useStandInNotifications(inbox, source(completed(), true), 'user', true, true))
    expect(send).not.toHaveBeenCalled()
  })

  it('does not notify or mark unread again when a settled turn receives its task summary', () => {
    const machine = new RuntimeTaskMachine(runtimeItem.address)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeItem.address,
      task: runtimeItem.task,
    })
    machine.dispatch({ type: 'turn_started', turnId: 'turn-1' })
    const hook = renderHook(
      ({ item }) => useStandInNotifications(inbox, source(item), 'user', true, true),
      { initialProps: { item: { ...runtimeItem, lifecycle: machine.getSnapshot() } } }
    )
    machine.dispatch({ type: 'executor_settled' })
    machine.dispatch({ type: 'turn_settled', turnId: 'turn-1', outcome: 'succeeded' })
    hook.rerender({ item: { ...runtimeItem, lifecycle: machine.getSnapshot() } })
    expect(send).toHaveBeenCalledTimes(1)
    act(() => hook.result.current.markRead(hook.result.current.items))
    const settled = completed()
    settled.task.runtimeHandle = { ...settled.task.runtimeHandle, lastTurnId: 'turn-1' }
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeItem.address,
      task: settled.task,
    })
    hook.rerender({ item: { ...settled, lifecycle: machine.getSnapshot() } })
    expect(send).toHaveBeenCalledTimes(1)
    expect(hook.result.current.unreadCount).toBe(0)
    hook.unmount()
    const restored = renderHook(() =>
      useStandInNotifications(inbox, source(settled), 'user', true, true)
    )
    expect(restored.result.current.unreadCount).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

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
  it('delivers a later turn even when its completion timestamp is unchanged', () => {
    const withTurn = (item: RuntimeTaskReminderItem, lastTurnId: string) => ({
      ...item,
      task: { ...item.task, runtimeHandle: { ...item.task.runtimeHandle, lastTurnId } },
    })
    const hook = renderHook(
      ({ item }) => useStandInNotifications(inbox, source(item), 'user', true, true),
      { initialProps: { item: withTurn(runtimeItem, 'turn-1') } }
    )
    hook.rerender({ item: withTurn(completed(), 'turn-1') })
    expect(send).toHaveBeenCalledTimes(1)
    act(() => hook.result.current.markRead(hook.result.current.items))
    hook.rerender({ item: withTurn(runtimeItem, 'turn-2') })
    hook.rerender({ item: withTurn(completed(), 'turn-2') })
    expect(send).toHaveBeenCalledTimes(2)
    expect(hook.result.current.unreadCount).toBe(1)
  })
  it('migrates existing read and delivery markers before metadata timestamps change', () => {
    const item = completed()
    const storageKey = 'wework.stand-in-notifications:user'
    const records = JSON.stringify({
      [item.key]: {
        version: 'completed:2026-10-21T12:04:00.000Z',
        savedAt: Date.now(),
      },
    })
    localStorage.setItem(storageKey, records)
    localStorage.setItem(`${storageKey}:delivered`, records)
    item.task.runtimeHandle = { ...item.task.runtimeHandle, lastTurnId: 'turn-1' }
    const hook = renderHook(
      ({ item }) => useStandInNotifications(inbox, source(item), 'user', true, true),
      { initialProps: { item } }
    )
    hook.rerender({
      item: { ...item, task: { ...item.task, completedAt: '2026-10-21T12:05:00Z' } },
    })
    expect(hook.result.current.unreadCount).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(storageKey)!)[item.key].version).toBe(
      'completed:turn:turn-1'
    )
    expect(JSON.parse(localStorage.getItem(`${storageKey}:delivered`)!)[item.key].version).toBe(
      'completed:turn:turn-1'
    )
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
