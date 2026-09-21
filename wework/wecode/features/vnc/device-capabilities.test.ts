import { describe, expect, test } from 'vitest'
import { supportsVncDesktop } from './device-capabilities'

describe('internal desktop capability', () => {
  test('does not enable VNC for remote devices even when they advertise desktop support', () => {
    const remoteDevice = {
      device_type: 'remote',
      bind_shell: 'claudecode',
      status: 'online',
      runtime_features: {
        schemaVersion: 4,
        desktop: {
          version: 1,
          available: true,
          protocol: 'rfb',
          transport: 'websocket',
          clipboard: 'extended-text',
        },
      },
    } as const

    expect(supportsVncDesktop(remoteDevice)).toBe(false)
    expect(supportsVncDesktop({ ...remoteDevice, status: 'offline' })).toBe(false)
  })

  test('enables VNC by default for cloud devices', () => {
    const cloudDevice = {
      device_type: 'cloud',
      bind_shell: 'claudecode',
      status: 'online',
    } as const

    expect(supportsVncDesktop(cloudDevice)).toBe(true)
    expect(
      supportsVncDesktop({
        ...cloudDevice,
        runtime_features: {
          schemaVersion: 4,
          desktop: {
            version: 1,
            available: false,
            protocol: 'rfb',
            transport: 'websocket',
            clipboard: 'text',
          },
        },
      })
    ).toBe(false)
  })
})
