import type { DeviceInfo } from '@wegent/chat-core/execution-project'
import { createBrowserRuntimeDeviceAccess } from '@/features/collaboration/runtimeDeviceAccess'

const app = {
  id: 1,
  device_id: 'app-logical',
  device_type: 'app',
  app_device_id: 'app-alias',
  socket_device_id: 'app-socket',
  runtime_routes: [
    {
      kind: 'app-ipc',
      device_id: 'app-route',
      runtime_device_id: 'app-runtime',
      device_type: 'app',
    },
  ],
} as DeviceInfo
const local = { id: 2, device_id: 'executor', device_type: 'local' } as DeviceInfo

it('resolves APP logical, database and runtime aliases without granting remote access', async () => {
  const check = createBrowserRuntimeDeviceAccess(jest.fn().mockResolvedValue([app, local]))
  expect(
    await check([
      'app-logical',
      '1',
      'app-alias',
      'app-socket',
      'app-route',
      'app-runtime',
      'executor',
      'missing',
    ])
  ).toEqual({
    'app-logical': 'app-local-only',
    '1': 'app-local-only',
    'app-alias': 'app-local-only',
    'app-socket': 'app-local-only',
    'app-route': 'app-local-only',
    'app-runtime': 'app-local-only',
    executor: 'allowed',
    missing: 'unavailable',
  })
})

it('coalesces simultaneous checks and reads fresh device data on later checks', async () => {
  const read = jest.fn().mockResolvedValue([app, local])
  const check = createBrowserRuntimeDeviceAccess(read)
  await Promise.all([check(['app-logical']), check(['executor'])])
  expect(read).toHaveBeenCalledTimes(1)
  read.mockResolvedValue([app])
  expect(await check(['executor'])).toEqual({ executor: 'unavailable' })
  expect(read).toHaveBeenCalledTimes(2)
})

it('propagates a failed catalog read and allows a later retry', async () => {
  const read = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([local])
  const check = createBrowserRuntimeDeviceAccess(read)
  await expect(check(['executor'])).rejects.toThrow('offline')
  expect(await check(['executor'])).toEqual({ executor: 'allowed' })
})
