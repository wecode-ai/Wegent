// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DeviceMonitorPanel from '@/features/admin/components/DeviceMonitorPanel'
import { adminApis } from '@/apis/admin'
import { toast } from 'sonner'

const mockAdminTranslations: Record<string, string> = {
  'common.cancel': '取消',
  'device_monitor.actions.upgrade_all_local': '升级全部本地设备',
  'device_monitor.actions.restart_all_cloud': '重启全部云设备',
  'device_monitor.errors.upgrade_all_local_failed': '批量升级本地设备失败',
  'device_monitor.confirm.upgrade_all_local_title': '确认升级全部本地设备',
  'device_monitor.confirm.upgrade_all_local_message':
    '将向所有符合条件的本地设备发送升级命令，可能影响正在运行的任务。请确认后继续。',
  'device_monitor.confirm.upgrade_all_local_confirm': '确认升级',
  'device_monitor.confirm.restart_all_cloud_title': '确认重启全部云设备',
  'device_monitor.confirm.restart_all_cloud_message':
    '将向所有云设备发送重启命令，可能中断正在运行的任务。请确认后继续。',
  'device_monitor.confirm.restart_all_cloud_confirm': '确认重启',
}
const mockAdminT = (key: string) => mockAdminTranslations[key] ?? key
const mockFallbackT = (key: string) => key
const mockUseTranslation = jest.fn((namespace?: string | string[]) => ({
  t: namespace === 'admin' ? mockAdminT : mockFallbackT,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: (namespace?: string | string[]) => mockUseTranslation(namespace),
}))

jest.mock('sonner', () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
    info: jest.fn(),
  },
}))

jest.mock('@/apis/admin', () => {
  const restartAllCloudDevices = jest.fn()
  const upgradeAllLocalDevices = jest.fn()

  return {
    restartAllCloudDevices,
    upgradeAllLocalDevices,
    adminApis: {
      getDeviceStats: jest.fn(),
      getDevices: jest.fn(),
      upgradeDevice: jest.fn(),
      restartDevice: jest.fn(),
      migrateDevice: jest.fn(),
      restartAllCloudDevices,
      upgradeAllLocalDevices,
      getDeviceBatchStatus: jest.fn(),
    },
  }
})

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    socket: null,
    isConnected: false,
  }),
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  AlertDialogAction: ({
    asChild,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean
    children: React.ReactNode
  }) =>
    asChild && React.isValidElement(children) ? (
      React.cloneElement(
        children as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>,
        props
      )
    ) : (
      <button {...props}>{children}</button>
    ),
}))

jest.mock('@/components/ui/select', () => {
  type MockSelectChildProps = {
    children?: React.ReactNode
    value?: string
  }

  const collectOptions = (
    children: React.ReactNode
  ): Array<{ value: string; label: React.ReactNode }> => {
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
      total: 2,
      user_count: 1,
      by_status: { online: 1, offline: 0, busy: 0 },
      by_device_type: { local: 1, cloud: 1 },
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

    mockedAdminApis.getDeviceBatchStatus.mockImplementation(batchId =>
      Promise.resolve({
        success: true,
        batch_id: batchId,
        action: 'local_upgrade',
        status: 'running',
        total: 1,
        message: 'Batch running',
        triggered: 0,
        failed: 0,
        skipped: 0,
        errors: [],
        items: [],
      })
    )
  })

  it('renders bulk action labels from the admin namespace', async () => {
    render(<DeviceMonitorPanel />)

    expect(await screen.findByText('升级全部本地设备')).toBeInTheDocument()
    expect(screen.getByText('重启全部云设备')).toBeInTheDocument()
    expect(mockUseTranslation).toHaveBeenCalledWith('admin')
  })

  it('refreshes only the device list when search changes', async () => {
    render(<DeviceMonitorPanel />)

    await waitFor(() => {
      expect(mockedAdminApis.getDeviceStats).toHaveBeenCalledTimes(1)
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(await screen.findByTestId('device-search-input'), {
      target: { value: 'mac' },
    })

    await waitFor(
      () => {
        expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(2)
      },
      { timeout: 1200 }
    )

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

    await waitFor(
      () => {
        expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(2)
      },
      { timeout: 1200 }
    )

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

    await waitFor(
      () => {
        expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(2)
      },
      { timeout: 1200 }
    )

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

  it('requires confirmation before triggering bulk cloud restart', async () => {
    mockedAdminApis.restartAllCloudDevices.mockResolvedValue({
      success: true,
      batch_id: 'cloud-batch-1',
      action: 'cloud_restart',
      status: 'pending',
      message: 'Restart queued',
      total: 1,
    })
    mockedAdminApis.getDeviceBatchStatus.mockResolvedValue({
      success: true,
      batch_id: 'cloud-batch-1',
      action: 'cloud_restart',
      status: 'completed',
      message: 'cloud_restart completed: 1 triggered, 0 failed, 0 skipped',
      total: 1,
      triggered: 1,
      failed: 0,
      skipped: 0,
      errors: [],
      items: [],
    })

    render(<DeviceMonitorPanel />)

    await waitFor(() => {
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByTestId('restart-all-cloud-devices-button'))

    expect(mockedAdminApis.restartAllCloudDevices).not.toHaveBeenCalled()
    expect(screen.getByText('确认重启全部云设备')).toBeInTheDocument()
    expect(
      screen.getByText('将向所有云设备发送重启命令，可能中断正在运行的任务。请确认后继续。')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('confirm-restart-all-cloud-devices-button'))

    await waitFor(() => {
      expect(mockedAdminApis.restartAllCloudDevices).toHaveBeenCalledTimes(1)
    })
    expect(mockedToast.success).toHaveBeenCalledWith('Restart queued')

    await waitFor(() => {
      expect(mockedAdminApis.getDeviceBatchStatus).toHaveBeenCalledWith('cloud-batch-1')
    })
    expect(mockedToast.success).toHaveBeenCalledWith(
      'cloud_restart completed: 1 triggered, 0 failed, 0 skipped'
    )
  })

  it('requires confirmation before triggering bulk local upgrade', async () => {
    mockedAdminApis.upgradeAllLocalDevices.mockResolvedValue({
      success: true,
      batch_id: 'local-batch-1',
      action: 'local_upgrade',
      status: 'pending',
      message: 'Upgrade queued',
      total: 1,
    })

    render(<DeviceMonitorPanel />)

    await waitFor(() => {
      expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByTestId('upgrade-all-local-devices-button'))

    expect(mockedAdminApis.upgradeAllLocalDevices).not.toHaveBeenCalled()
    expect(screen.getByText('确认升级全部本地设备')).toBeInTheDocument()
    expect(
      screen.getByText(
        '将向所有符合条件的本地设备发送升级命令，可能影响正在运行的任务。请确认后继续。'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('confirm-upgrade-all-local-devices-button'))

    await waitFor(() => {
      expect(mockedAdminApis.upgradeAllLocalDevices).toHaveBeenCalledTimes(1)
    })
    expect(mockedToast.success).toHaveBeenCalledWith('Upgrade queued')

    await waitFor(() => {
      expect(mockedAdminApis.getDeviceBatchStatus).toHaveBeenCalledWith('local-batch-1')
    })
    expect(screen.getByTestId('device-batch-local-batch-1')).toBeInTheDocument()
  })

  it('shows a localized error when bulk local upgrade fails', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockedAdminApis.upgradeAllLocalDevices.mockRejectedValue(new Error('request failed'))

    try {
      render(<DeviceMonitorPanel />)

      await waitFor(() => {
        expect(mockedAdminApis.getDevices).toHaveBeenCalledTimes(1)
      })

      fireEvent.click(screen.getByTestId('upgrade-all-local-devices-button'))
      fireEvent.click(screen.getByTestId('confirm-upgrade-all-local-devices-button'))

      await waitFor(() => {
        expect(mockedToast.error).toHaveBeenCalledWith('批量升级本地设备失败')
      })
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })
})
