import { describe, expect, test, vi } from 'vitest'
import { resolveDesktopDeviceName } from './desktop-device-name.js'

describe('desktop device name', () => {
  test('keeps an explicit device name', async () => {
    const readMacComputerName = vi.fn()

    await expect(
      resolveDesktopDeviceName({
        environment: { DEVICE_NAME: 'Configured Mac' },
        platform: 'darwin',
        readHostname: () => 'host-name',
        readMacComputerName,
      })
    ).resolves.toBe('Configured Mac')
    expect(readMacComputerName).not.toHaveBeenCalled()
  })

  test('uses the macOS ComputerName shown in system settings', async () => {
    await expect(
      resolveDesktopDeviceName({
        environment: {},
        platform: 'darwin',
        readHostname: () => 'host-name',
        readMacComputerName: async () => '公司发的MicroLee用的MacbookPro\n',
      })
    ).resolves.toBe('公司发的MicroLee用的MacbookPro')
  })

  test('uses the hostname when the platform display name is unavailable', async () => {
    await expect(
      resolveDesktopDeviceName({
        environment: {},
        platform: 'darwin',
        readHostname: () => 'microlee-macbook-pro.local',
        readMacComputerName: async () => {
          throw new Error('ComputerName is unavailable')
        },
      })
    ).resolves.toBe('microlee-macbook-pro.local')
  })
})
