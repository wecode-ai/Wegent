// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { DeviceInfo } from '@/apis/devices'
import DeviceSelectorTab from '@/features/tasks/components/input/DeviceSelectorTab'

const mockSetSelectedDeviceId = jest.fn()
let mockDevices: DeviceInfo[] = []

function createDevice(overrides: Partial<DeviceInfo>): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'macOS-Device',
    status: 'online',
    is_default: false,
    device_type: 'local',
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 1,
    running_tasks: [],
    executor_version: null,
    latest_version: null,
    update_available: false,
    ...overrides,
  }
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}))

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    devices: mockDevices,
    selectedDeviceId: null,
    setSelectedDeviceId: mockSetSelectedDeviceId,
    isLoading: false,
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      preferences: {
        default_execution_target: null,
      },
    },
    updatePreferences: jest.fn().mockResolvedValue(undefined),
  }),
}))

jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('DeviceSelectorTab', () => {
  beforeEach(() => {
    mockSetSelectedDeviceId.mockClear()
    mockDevices = [createDevice({})]
  })

  it('does not render nested buttons inside device cards and keeps card keyboard-selectable', () => {
    const { container } = render(<DeviceSelectorTab />)

    const deviceCard = screen.getByTestId('device-card-device-1')
    const setDefaultButton = screen.getByTestId('set-default-device-device-1')

    expect(deviceCard.tagName).toBe('DIV')
    expect(setDefaultButton.tagName).toBe('BUTTON')
    expect(container.querySelector('button button')).not.toBeInTheDocument()

    fireEvent.keyDown(deviceCard, { key: 'Enter' })

    expect(mockSetSelectedDeviceId).toHaveBeenCalledWith('device-1')
  })

  it('shows online devices over total registered devices in the trigger summary', () => {
    mockDevices = [
      createDevice({
        id: 1,
        device_id: 'device-1',
        name: 'Online Device',
        status: 'online',
      }),
      createDevice({
        id: 2,
        device_id: 'device-2',
        name: 'Offline Device',
        status: 'offline',
      }),
    ]

    render(<DeviceSelectorTab />)

    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('renders offline devices in the list and keeps them disabled', () => {
    mockDevices = [
      createDevice({
        id: 1,
        device_id: 'device-1',
        name: 'Online Device',
        status: 'online',
      }),
      createDevice({
        id: 2,
        device_id: 'device-2',
        name: 'Offline Device',
        status: 'offline',
      }),
    ]

    render(<DeviceSelectorTab />)

    const offlineDeviceCard = screen.getByTestId('device-card-device-2')

    expect(offlineDeviceCard).toBeInTheDocument()
    expect(offlineDeviceCard).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByText('no_devices_available')).not.toBeInTheDocument()
  })
})
