import { act } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { createWorkbenchDeviceReconnect } from './workbenchDeviceReconnect'

const device = (id: string, status: DeviceInfo['status']): DeviceInfo => ({
  id: 1,
  device_id: id,
  name: id,
  device_type: 'remote',
  status,
  is_default: false,
  bind_shell: 'claudecode',
})

function fixture(
  input: Parameters<ReturnType<typeof createWorkbenchDeviceReconnect>['update']>[0]
) {
  const owner = createWorkbenchDeviceReconnect()
  owner.update(input)
  return { rerender: (next: Partial<typeof input>) => owner.update({ ...input, ...next }) }
}

describe('device-owned read recovery', () => {
  test('refreshes once when the same owner returns, including an initially unknown device', () => {
    const onReconnect = vi.fn()
    const { rerender } = fixture({ deviceId: 'owner', devices: [] as DeviceInfo[], onReconnect })
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
    const { rerender } = fixture({
      deviceId: 'owner',
      devices: [device('owner', 'offline')],
      onReconnect,
    })
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
