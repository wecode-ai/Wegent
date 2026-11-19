// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { deviceApis, type DeviceInfo } from '@/apis/devices'
import { DeviceCard } from '@/features/devices/components/DeviceCard'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('DeviceCard IDE menu', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each<DeviceInfo['device_type']>(['cloud', 'remote'])(
    'opens the selected %s device from its menu',
    async deviceType => {
      const device: DeviceInfo = {
        id: 1,
        device_id: `${deviceType}-executor`,
        name: 'Test Executor',
        status: 'online',
        device_type: deviceType,
        is_default: false,
        connection_mode: 'websocket',
        slot_used: 0,
        slot_max: 1,
        running_tasks: [],
        executor_version: null,
        latest_version: null,
        update_available: false,
      }
      const url = 'https://ide.example.test/s/code-1/'
      const tab = { opener: window, location: { replace: jest.fn() } }
      jest.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
      const start = jest.spyOn(deviceApis, 'startCodeServer').mockResolvedValue({ url })
      render(
        <DeviceCard
          device={device}
          onStartTask={jest.fn()}
          onSetDefault={jest.fn()}
          onDelete={jest.fn()}
          onCancelTask={jest.fn()}
        />
      )

      fireEvent.keyDown(screen.getByTestId('device-menu-1'), { key: 'ArrowDown' })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'ide.open' }))

      expect(start).toHaveBeenCalledWith(device.device_id)
      await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(url))
    }
  )
})
