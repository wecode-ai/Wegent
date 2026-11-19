import { renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { useRuntimeTaskOwnerKey } from './useRuntimeTaskOwnerKey'

const devices: DeviceInfo[] = [
  {
    id: 79,
    device_id: 'electron-local',
    socket_device_id: 'app-record-79',
    name: 'Local',
    status: 'online',
    device_type: 'local',
    is_default: true,
  },
]
const task = (deviceId: string): RuntimeTaskAddress => ({ deviceId, taskId: 'same-task' })

test('keeps UI ownership across proven aliases while isolating other tasks and devices', () => {
  const { result, rerender } = renderHook(
    ({ address, knownDevices }) => useRuntimeTaskOwnerKey(address, knownDevices),
    { initialProps: { address: task('app-record-79'), knownDevices: [] as DeviceInfo[] } }
  )
  const original = result.current
  rerender({ address: task('app-record-79'), knownDevices: devices })
  rerender({ address: task('electron-local'), knownDevices: devices })
  expect(result.current).toBe(original)
  rerender({
    address: { ...task('electron-local'), taskId: 'another-task' },
    knownDevices: devices,
  })
  expect(result.current).not.toBe(original)
  rerender({ address: task('other-device'), knownDevices: devices })
  expect(result.current).toBe('task:other-device:same-task')
})

test('never transfers ownership through an ambiguous alias', () => {
  const { result, rerender } = renderHook(
    ({ address, knownDevices }) => useRuntimeTaskOwnerKey(address, knownDevices),
    { initialProps: { address: task('app-record-79'), knownDevices: [] as DeviceInfo[] } }
  )
  const original = result.current
  rerender({
    address: task('electron-local'),
    knownDevices: [...devices, { ...devices[0], id: 80, device_id: 'another-runtime' }],
  })
  expect(result.current).not.toBe(original)
})
