// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DeviceMonitorPanel from '@/features/admin/components/DeviceMonitorPanel'
import { adminApis } from '@/apis/admin'
import { toast } from 'sonner'

const mockT = (key: string) => key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
    info: jest.fn(),
  },
}))

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getDeviceStats: jest.fn(),
    getDevices: jest.fn(),
    upgradeDevice: jest.fn(),
    restartDevice: jest.fn(),
    migrateDevice: jest.fn(),
  },
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/components/ui/select', () => {
  type MockSelectChildProps = {
    children?: React.ReactNode
    value?: string
  }

  const collectOptions = (children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> => {
    const options: Array<{ value: string; label: React.ReactNode }> = []

    React.Children.forEach(children, child => {
      if (!React.isValidElement<MockSelectChildProps>(child)) {
        return
      }

      if ((child.type as { displayName?: string }).displayName === 'MockSelectItem') {
        options.push({ value: child.props.value ?? '', label: child.props.children })
      }

      if (child.props.children) {
        options.push(...collectOptions(child.props.children))
      }
    })

    return options
  }

  const injectTriggerProps = (
    children: React.ReactNode,
    props: {
      value?: string
      onValueChange?: (value: string) => void
      disabled?: boolean
      options: Array<{ value: string; label: React.ReactNode }>
    }
  ): React.ReactNode =>
    React.Children.map(children, child => {
      if (!React.isValidElement<MockSelectChildProps>(child)) {
        return child
      }

      if ((child.type as { displayName?: string }).displayName === 'MockSelectTrigger') {
        return React.cloneElement(child as React.ReactElement<typeof props>, props)
      }

      if (child.props.children) {
        return React.cloneElement(child as React.ReactElement<MockSelectChildProps>, {
          children: injectTriggerProps(child.props.children, props),
        })
      }

      return child
    })

  const Select = ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => {
    const options = collectOptions(children)
    return <>{injectTriggerProps(children, { value, onValueChange, disabled, options })}</>
  }

  const SelectTrigger = ({
    value,
    onValueChange,
    disabled,
    options,
    children: _children,
    ...props
  }: {
    value?: string
    onValueChange?: (value: string) => void
    disabled?: boolean
    options?: Array<{ value: string; label: React.ReactNode }>
    children?: React.ReactNode
  } & React.SelectHTMLAttributes<HTMLSelectElement>) => (
    <select
      {...props}
      value={value}
      onChange={event => onValueChange?.(event.target.value)}
      disabled={disabled}
    >
      {options?.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
  SelectTrigger.displayName = 'MockSelectTrigger'

  const SelectContent = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const SelectValue = () => null
  const SelectItem = ({ children }: { value: string; children: React.ReactNode }) => <>{children}</>
  SelectItem.displayName = 'MockSelectItem'

  return {
    Select,
    SelectTrigger,
    SelectContent,
    SelectValue,
    SelectItem,
  }
})

describe('DeviceMonitorPanel', () => {
  const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>
  const mockedToast = toast as jest.Mocked<typeof toast>

  beforeEach(() => {
    jest.clearAllMocks()

    mockedAdminApis.getDeviceStats.mockResolvedValue({
      total: 1,
      user_count: 1,
      by_status: { online: 1, offline: 0, busy: 0 },
      by_device_type: { local: 1, cloud: 0 },
      by_bind_shell: { claudecode: 1, openclaw: 0 },
    })

    mockedAdminApis.getDevices.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 1,
          device_id: 'device-1',
          name: 'macOS-device',
          status: 'online',
          device_type: 'local',
          bind_shell: 'claudecode',
          user_id: 1,
          user_name: 'alice',
          client_ip: '127.0.0.1',
          executor_version: '1.7.0',
          slot_used: 0,
          slot_max: 0,
          created_at: '2026-03-31T12:00:00',
        },
      ],
    })
  })

  it('refreshes only the device list when search changes', async () => {
    render(<DeviceMonitorPanel />)

    await waitFor(() => {
      expect(mockedAdminApis.getDeviceStats).toHaveBeenCalledTimes(1)
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(screen.getByTestId('device-search-input'), {
      target: { value: 'mac' },
    })

    await waitFor(() => {
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(2)
    }, { timeout: 1200 })

    expect(mockedAdminApis.getDeviceStats).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('device-card-device-1')).toBeInTheDocument()
  })

  it('passes version filter params when version input changes', async () => {
    render(<DeviceMonitorPanel />)

    await waitFor(() => {
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(screen.getByTestId('version-filter-input'), {
      target: { value: '1.6.5' },
    })

    await waitFor(() => {
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(2)
    }, { timeout: 1200 })

    expect(mockedAdminApis.getDevices).toHaveBeenLastCalledWith(
      1,
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      'lt',
      '1.6.5'
    )
    expect(mockedAdminApis.getDeviceStats).toHaveBeenCalledTimes(1)
  })

  it('does not send incomplete version filters while typing', async () => {
    render(<DeviceMonitorPanel />)

    await waitFor(() => {
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(screen.getByTestId('version-filter-input'), {
      target: { value: '1.' },
    })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 700))
    })

    expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(1)
    expect(mockedToast.error).not.toHaveBeenCalled()
  })

  it('disables version filter when offline status is selected', async () => {
    render(<DeviceMonitorPanel />)

    await waitFor(() => {
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(screen.getByTestId('device-status-filter-select'), {
      target: { value: 'offline' },
    })

    await waitFor(() => {
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(2)
    }, { timeout: 1200 })

    expect(screen.getByTestId('version-filter-input')).toBeDisabled()
    expect(mockedAdminApis.getDevices).toHaveBeenLastCalledWith(
      1,
      20,
      'offline',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
  })
})
