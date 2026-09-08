// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@/apis/devices'
import DevicesPage from '@/app/(tasks)/devices/page'

const devices: DeviceInfo[] = [
  {
    id: 1,
    device_id: 'executor-device',
    name: 'Executor Device',
    status: 'online',
    is_default: true,
    device_type: 'local',
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 1,
    running_tasks: [],
    executor_version: '1.8.8',
    latest_version: '1.8.8',
    update_available: false,
    bind_shell: 'claudecode',
  },
  {
    id: 2,
    device_id: 'openclaw-device',
    name: 'OpenClaw Device',
    status: 'online',
    is_default: false,
    device_type: 'local',
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 1,
    running_tasks: [],
    executor_version: '1.8.8',
    latest_version: '1.8.8',
    update_available: false,
    bind_shell: 'openclaw',
  },
  {
    id: 3,
    device_id: 'wework-openclaw-device',
    name: 'Wework OpenClaw Device',
    status: 'online',
    is_default: false,
    device_type: 'app',
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 1,
    running_tasks: [],
    executor_version: '1.8.8',
    latest_version: '1.8.8',
    update_available: false,
    bind_shell: 'openclaw',
  },
]

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}))

jest.mock('@/features/layout/TopNavigation', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/features/tasks/components/sidebar', () => ({
  TaskSidebar: () => null,
  ResizableSidebar: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CollapsedSidebarButtons: () => null,
}))

jest.mock('@/features/layout/GithubStarButton', () => ({ GithubStarButton: () => null }))
jest.mock('@/features/theme/ThemeToggle', () => ({ ThemeToggle: () => null }))
jest.mock('@/features/layout/hooks/useMediaQuery', () => ({ useIsMobile: () => false }))
jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({ selectTask: jest.fn() }),
}))
jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    devices,
    isLoading: false,
    error: null,
    refreshDevices: jest.fn(),
    isDeviceUpgrading: () => false,
    getUpgradeStatus: () => undefined,
  }),
}))
jest.mock('@/apis/user', () => ({ getToken: () => 'token' }))
jest.mock('@/lib/runtime-config', () => ({ getSocketUrl: () => 'https://example.test' }))
jest.mock('@/features/devices/hooks', () => ({
  useDeviceHandlers: () => ({
    handleStartTask: jest.fn(),
    handleSetDefault: jest.fn(),
    handleDeleteDevice: jest.fn(),
    handleCancelTask: jest.fn(),
    handleUpgradeDevice: jest.fn(),
    handleEditAlias: jest.fn(),
  }),
}))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/features/devices/components', () => {
  const actual = jest.requireActual('@/features/devices/components')
  return {
    ...actual,
    DeviceCard: ({ device }: { device: DeviceInfo }) => (
      <div data-testid={`page-device-${device.device_id}`}>{device.name}</div>
    ),
    DeviceSetupGuide: () => null,
    EditDeviceAliasDialog: () => null,
  }
})

describe('DevicesPage advanced mode', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('hides OpenClaw by default and persists the advanced-mode opt in', async () => {
    const { unmount } = render(<DevicesPage />)

    expect(screen.getByTestId('page-device-executor-device')).toBeInTheDocument()
    expect(screen.queryByTestId('page-device-openclaw-device')).not.toBeInTheDocument()
    expect(screen.queryByTestId('page-device-wework-openclaw-device')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('show-advanced-devices-toggle'))

    expect(screen.getByTestId('page-device-openclaw-device')).toBeInTheDocument()
    expect(screen.getByTestId('page-device-wework-openclaw-device')).toBeInTheDocument()
    expect(localStorage.getItem('wegent_show_advanced_devices')).toBe('true')

    unmount()
    render(<DevicesPage />)

    await waitFor(() =>
      expect(screen.getByTestId('page-device-openclaw-device')).toBeInTheDocument()
    )
    expect(screen.getByTestId('page-device-wework-openclaw-device')).toBeInTheDocument()
  })
})
