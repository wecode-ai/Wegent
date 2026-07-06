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

vi.mock('@/api/quota', () => ({
  createQuotaApi: () => ({
    fetchQuota: vi.fn(),
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

  test('renders the account area as a non-clickable muted group', () => {
    renderMenu()

    const accountGroup = screen.getByTestId('settings-account-group')
    const accountItem = screen.getByTestId('account-menu-button')

    expect(accountGroup).toHaveTextContent('user@example.com')
    expect(accountItem.tagName).toBe('DIV')
    expect(accountItem).toHaveClass('cursor-default', 'text-text-secondary')
    expect(accountItem).not.toHaveClass('hover:bg-white/[0.08]')
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
})
