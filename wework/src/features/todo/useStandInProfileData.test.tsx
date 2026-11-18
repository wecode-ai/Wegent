import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { Automation } from '@/types/automation'
import type { AutomationApi } from '@/features/workbench/workbenchServices'
import { useStandInProfileSchedules } from './useStandInProfileData'
import { WORKBENCH_AUTOMATIONS_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'

const automation = {
  id: 'schedule',
  taskRequest: {
    deviceId: 'device',
    standInOwner: { userId: 7, roleId: 'role' },
    standInCalendar: {},
  },
} as Automation

it('isolates schedules by owner, role, device and calendar ownership', async () => {
  const listAutomations = vi.fn().mockResolvedValue({
    items: [
      automation,
      {
        ...automation,
        id: 'foreign-user',
        taskRequest: { ...automation.taskRequest, standInOwner: { userId: 8, roleId: 'role' } },
      },
      {
        ...automation,
        id: 'foreign-role',
        taskRequest: { ...automation.taskRequest, standInOwner: { userId: 7, roleId: 'other' } },
      },
      {
        ...automation,
        id: 'foreign-device',
        taskRequest: { ...automation.taskRequest, deviceId: 'other' },
      },
      {
        ...automation,
        id: 'ordinary',
        taskRequest: { ...automation.taskRequest, standInCalendar: undefined },
      },
    ],
  })
  const api = { listAutomations } as unknown as AutomationApi
  const { result, rerender } = renderHook(
    ({ role }) => useStandInProfileSchedules(api, 7, role, 'device'),
    { initialProps: { role: 'role' } }
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.items.map(item => item.id)).toEqual(['schedule'])
  rerender({ role: 'other' })
  expect(result.current.items).toEqual([])
  await waitFor(() => expect(result.current.items.map(item => item.id)).toEqual(['foreign-role']))
})

it('keeps schedule errors separate and supports retry', async () => {
  const api = {
    listAutomations: vi
      .fn()
      .mockRejectedValueOnce({ code: 'device_offline' })
      .mockResolvedValue({ items: [automation] }),
  } as unknown as AutomationApi
  const { result } = renderHook(() => useStandInProfileSchedules(api, 7, 'role', 'device'))
  await waitFor(() => expect(result.current.error).toBe('执行设备离线，请连接设备后重试。'))
  act(() => result.current.retry())
  await waitFor(() => expect(result.current.items).toEqual([automation]))
  expect(result.current.error).toBeUndefined()
})

it('owns refresh timers and change events only while its API is subscribed', async () => {
  vi.useFakeTimers()
  try {
    const listAutomations = vi.fn().mockResolvedValue({ items: [automation] })
    const api = { listAutomations } as unknown as AutomationApi
    const { result, rerender, unmount } = renderHook(
      ({ source }: { source: AutomationApi | undefined }) =>
        useStandInProfileSchedules(source, 7, 'role', 'device'),
      { initialProps: { source: undefined as AutomationApi | undefined } }
    )
    expect(vi.getTimerCount()).toBe(0)
    act(() => result.current.retry())
    expect(listAutomations).not.toHaveBeenCalled()
    rerender({ source: api })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.items).toEqual([automation])
    expect(vi.getTimerCount()).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(listAutomations).toHaveBeenCalledTimes(2)
    await act(async () => window.dispatchEvent(new Event(WORKBENCH_AUTOMATIONS_CHANGED_EVENT)))
    expect(listAutomations).toHaveBeenCalledTimes(3)
    rerender({ source: undefined })
    expect(result.current.items).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => window.dispatchEvent(new Event(WORKBENCH_AUTOMATIONS_CHANGED_EVENT)))
    expect(listAutomations).toHaveBeenCalledTimes(3)
    unmount()
  } finally {
    vi.useRealTimers()
  }
})
