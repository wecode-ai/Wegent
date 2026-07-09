import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'

const mockCheckNow = vi.fn()
const mockInstallUpdate = vi.fn()
const runtimeModeMock = vi.hoisted(() => ({
  isLocalFirstAppRuntime: vi.fn(() => false),
}))
let mockUpdateState = {
  availableUpdate: null as null | { currentVersion: string; version: string },
  status: 'idle',
  error: null as string | null,
  checkNow: mockCheckNow,
  installUpdate: mockInstallUpdate,
}

vi.mock('@/features/app-update/app-update-context', () => ({
  useOptionalAppUpdate: () => mockUpdateState,
}))

vi.mock('@/lib/runtime-mode', () => runtimeModeMock)

vi.mock('@/api/local/codexUsage', () => ({
  formatCodexUsageResetTime: (resetsAt: number | null) =>
    resetsAt === 1 ? '11:30' : resetsAt === 2 ? '1月5日 09:15' : null,
  emptyCodexUsageDisplay: () => ({
    status: 'none',
    fiveHour: { label: '5h', title: '5小时额度', value: '无', percent: null, resetsAt: null },
    sevenDay: { label: '7d', title: '7天额度', value: '无', percent: null, resetsAt: null },
    trayTitle: '5h --\n7d --',
    tooltip: '5小时额度 无\n7天额度 无',
  }),
  getLocalCodexUsageDisplay: vi.fn().mockResolvedValue({
    status: 'available',
    fiveHour: { label: '5h', title: '5小时额度', value: '90%', percent: 90, resetsAt: 1 },
    sevenDay: { label: '7d', title: '7天额度', value: '80%', percent: 80, resetsAt: 2 },
    trayTitle: '5h 90%\n7d 80%',
    tooltip: '5小时额度 90%\n7天额度 80%',
  }),
}))

function renderMenu() {
  render(
    <DesktopSettingsMenu
      user={{ id: 1, email: 'user@example.com', user_name: 'User' }}
      onOpenSettings={vi.fn()}
      onLogout={vi.fn()}
    />
  )
}

describe('DesktopSettingsMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateState = {
      availableUpdate: null,
      status: 'idle',
      error: null,
      checkNow: mockCheckNow,
      installUpdate: mockInstallUpdate,
    }
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(false)
  })

  test('checks for app updates from the settings menu', async () => {
    mockCheckNow.mockResolvedValue(null)

    renderMenu()

    await userEvent.click(screen.getByTestId('check-app-update-button'))

    expect(mockCheckNow).toHaveBeenCalledTimes(1)
  })

  test('does not render the old account or quota summary row', () => {
    renderMenu()

    expect(screen.queryByTestId('settings-account-group')).not.toBeInTheDocument()
    expect(screen.queryByTestId('account-menu-button')).not.toBeInTheDocument()
    expect(screen.queryByText('Codex 额度')).not.toBeInTheDocument()
  })

  test('hides logout in local-first app runtime', () => {
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(true)

    renderMenu()

    expect(screen.queryByTestId('logout-menu-button')).not.toBeInTheDocument()
    expect(screen.queryByText('退出登录')).not.toBeInTheDocument()
  })

  test('installs a discovered app update', async () => {
    mockUpdateState = {
      ...mockUpdateState,
      availableUpdate: {
        currentVersion: '0.1.0',
        version: '0.1.1',
      },
      status: 'available',
    }
    mockInstallUpdate.mockResolvedValue(undefined)

    renderMenu()

    const updateButton = screen.getByTestId('check-app-update-button')
    expect(updateButton).toHaveTextContent('更新到 0.1.1')

    await userEvent.click(updateButton)
    expect(mockInstallUpdate).toHaveBeenCalledTimes(1)
  })

  test('shows usage reset times in the expanded usage panel', async () => {
    renderMenu()

    await userEvent.click(screen.getByTestId('usage-menu-button'))

    expect(await screen.findByText('11:30 重置')).toBeInTheDocument()
    expect(screen.getByText('1月5日 09:15 重置')).toBeInTheDocument()
  })
})
