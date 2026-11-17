import { act, renderHook } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { useWorkbenchDeviceReconnect } from './useWorkbenchDeviceReconnect'

const device = (id: string, status: DeviceInfo['status']): DeviceInfo => ({
  id: 1,
  device_id: id,
  name: id,
  device_type: 'remote',
  status,
  is_default: false,
  bind_shell: 'claudecode',
})

describe('device-owned read recovery', () => {
  test('refreshes once when the same owner returns, including an initially unknown device', () => {
    const onReconnect = vi.fn()
    const { rerender } = renderHook(
      ({ devices }) => useWorkbenchDeviceReconnect({ deviceId: 'owner', devices, onReconnect }),
      { initialProps: { devices: [] as DeviceInfo[] } }
    )
    act(() => rerender({ devices: [device('owner', 'online')] }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
    act(() => rerender({ devices: [device('owner', 'busy')] }))
    act(() => rerender({ devices: [device('owner', 'online')] }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
    act(() => rerender({ devices: [device('owner', 'offline')] }))
    act(() => rerender({ devices: [device('owner', 'online')] }))
    expect(onReconnect).toHaveBeenCalledTimes(2)
  })

  test('does not refresh for unrelated devices or an owner change', () => {
    const onReconnect = vi.fn()
    const { rerender } = renderHook(
      ({ deviceId, devices }) => useWorkbenchDeviceReconnect({ deviceId, devices, onReconnect }),
      { initialProps: { deviceId: 'owner', devices: [device('owner', 'offline')] } }
    )
    act(() =>
      rerender({
        deviceId: 'owner',
        devices: [device('owner', 'offline'), device('other', 'online')],
      })
    )
    act(() =>
      rerender({
        deviceId: 'other',
        devices: [device('owner', 'offline'), device('other', 'online')],
      })
    )
    expect(onReconnect).not.toHaveBeenCalled()
  })
})
