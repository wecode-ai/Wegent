import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { Automation } from '@/types/automation'
import type { AutomationApi } from '@/features/workbench/workbenchServices'
import { useStandInProfileSchedules } from './useStandInProfileData'

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
