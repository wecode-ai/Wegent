// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import type { DeviceInfo } from '@/apis/devices'
import { DeviceCard } from '@/features/devices/components/DeviceCard'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/features/devices/components/RunningTasksList', () => ({
  RunningTasksList: () => null,
}))
jest.mock('@/features/devices/components/VersionBadge', () => ({ VersionBadge: () => null }))

const baseDevice: DeviceInfo = {
  id: 1,
  device_id: 'test-device',
  name: 'Test device',
  status: 'offline',
  device_type: 'app',
  is_default: false,
  connection_mode: 'websocket',
  slot_used: 0,
  slot_max: 1,
  running_tasks: [],
  executor_version: null,
  latest_version: null,
  update_available: false,
}

const callbacks = {
  onStartTask: jest.fn(),
  onSetDefault: jest.fn(),
  onDelete: jest.fn(),
  onCancelTask: jest.fn(),
}

async function openDeleteMenu() {
  fireEvent.keyDown(screen.getByTestId('device-menu-1'), { key: 'ArrowDown' })
  return screen.findByTestId('delete-device-1')
}

describe.each<DeviceInfo['device_type']>(['app', 'remote', 'local', 'cloud'])(
  '%s device deletion',
  deviceType => {
    beforeEach(() => jest.clearAllMocks())

    it.each<DeviceInfo['status']>(['online', 'busy', 'offline'])(
      'enforces deletion rules while %s',
      async status => {
        const device = { ...baseDevice, device_type: deviceType, status }
        render(<DeviceCard device={device} {...callbacks} />)
        const menu = await openDeleteMenu()
        if (deviceType !== 'cloud' && status !== 'offline') {
          expect(menu).toHaveAttribute('aria-disabled', 'true')
          return
        }
        expect(menu).not.toHaveAttribute('aria-disabled', 'true')
        fireEvent.click(menu)
        expect(await screen.findByRole('alertdialog')).toBeVisible()
        expect(callbacks.onDelete).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('confirm-delete-device'))
        expect(callbacks.onDelete).toHaveBeenCalledWith(device)
      }
    )

    it('allows occupied slots and unfinished tasks only for cloud devices', async () => {
      render(
        <DeviceCard
          device={{
            ...baseDevice,
            device_type: deviceType,
            slot_used: 1,
            running_tasks: [{ task_id: 1, subtask_id: 1, title: 'Task', status: 'RUNNING' }],
          }}
          {...callbacks}
        />
      )
      const menu = await openDeleteMenu()
      if (deviceType === 'cloud') expect(menu).not.toHaveAttribute('aria-disabled', 'true')
      else expect(menu).toHaveAttribute('aria-disabled', 'true')
    })

    it('rechecks online state while the confirmation dialog is open', async () => {
      const device = { ...baseDevice, device_type: deviceType }
      const { rerender } = render(<DeviceCard device={device} {...callbacks} />)
      fireEvent.click(await openDeleteMenu())
      await screen.findByRole('alertdialog')
      rerender(<DeviceCard device={{ ...device, status: 'online' }} {...callbacks} />)
      const confirm = screen.getByTestId('confirm-delete-device')
      if (deviceType === 'cloud') expect(confirm).toBeEnabled()
      else {
        expect(confirm).toBeDisabled()
        fireEvent.click(confirm)
        expect(callbacks.onDelete).not.toHaveBeenCalled()
      }
    })
  }
)
