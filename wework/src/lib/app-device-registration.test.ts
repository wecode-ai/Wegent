import { describe, expect, test } from 'vitest'
import { isCurrentAppDevice } from './app-device-registration'

describe('app device registration', () => {
  test.each([
    ['device_id', { device_id: 'current-device' }],
    ['app_device_id', { device_id: 'registered-device', app_device_id: 'current-device' }],
    ['socket_device_id', { device_id: 'registered-device', socket_device_id: 'current-device' }],
  ])('recognizes the current computer by %s', (_identity, values) => {
    expect(
      isCurrentAppDevice(
        {
          device_type: 'app',
          app_device_id: null,
          socket_device_id: null,
          ...values,
        },
        ['current-device']
      )
    ).toBe(true)
  })

  test('does not infer the current computer from its type or display name', () => {
    expect(
      isCurrentAppDevice(
        {
          device_id: 'another-device',
          device_type: 'app',
          app_device_id: null,
          socket_device_id: null,
        },
        ['current-device']
      )
    ).toBe(false)
  })
})
