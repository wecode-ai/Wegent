import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getLocalCodexUsageDisplay } from '@/api/local/codexUsage'
import { getWegentUsageDisplay } from '@/api/wegentUsage'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'

const mockCheckNow = vi.fn()
const mockInstallUpdate = vi.fn()
const runtimeModeMock = vi.hoisted(() => ({
  isLocalFirstAppRuntime: vi.fn(() => false),
}))
let mockUpdateState = {
  availableUpdate: null as null | { currentVersion: string; version: string },
  status: 'idle',
  downloadProgress: null as null | { downloadedBytes: number; totalBytes: number | null },
  error: null as string | null,
  checkNow: mockCheckNow,
  installUpdate: mockInstallUpdate,
}

vi.mock('@/features/app-update/app-update-context', () => ({
  useOptionalAppUpdate: () => mockUpdateState,
}))

vi.mock('@/lib/runtime-mode', () => runtimeModeMock)

vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => ({
    isConnected: true,
    apiBaseUrl: 'https://wegent.example.com/api',
    token: 'token',
  }),
}))

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

vi.mock('@/api/wegentUsage', () => ({
  emptyWegentUsageDisplay: () => ({
    status: 'none',
    sourceText: '',
    sourceLabel: 'Quota',
    quota: 0,
    usage: 0,
    remaining: 0,
    usageRate: null,
    value: '--',
    detail: '',
    trayTitle: 'Quota --',
    tooltip: '',
  }),
  getWegentUsageDisplay: vi.fn().mockResolvedValue({
    status: 'available',
    sourceText: 'AIGC额度',
    sourceLabel: 'AIGC',
    quota: 1042,
    usage: 1126.7,
    remaining: -84.7,
    usageRate: 108.13,
    value: '1,126.7 / 1,042 元',
    detail: '已用 108.13% · 剩余 -84.7 元',
    trayTitle: 'AIGC -84.7',
    tooltip: 'AIGC额度\n1,126.7 / 1,042 元 (108.13%)\n剩余 -84.7 元',
  }),
}))

const getLocalCodexUsageDisplayMock = vi.mocked(getLocalCodexUsageDisplay)
const getWegentUsageDisplayMock = vi.mocked(getWegentUsageDisplay)

function renderMenu({
  showLogout,
  onLogout = vi.fn(),
  onLogin,
  onOpenAbout = vi.fn(),
}: {
  showLogout?: boolean
  onLogout?: () => void
  onLogin?: () => void
  onOpenAbout?: () => void
} = {}) {
  render(
    <DesktopSettingsMenu
      user={{ id: 1, email: 'user@example.com', user_name: 'User' }}
      onOpenSettings={vi.fn()}
      onOpenAbout={onOpenAbout}
      onLogout={onLogout}
      onLogin={onLogin}
      showLogout={showLogout}
    />
  )
}

describe('DesktopSettingsMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateState = {
      availableUpdate: null,
      status: 'idle',
      downloadProgress: null,
      error: null,
      checkNow: mockCheckNow,
      installUpdate: mockInstallUpdate,
    }
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(false)
    getLocalCodexUsageDisplayMock.mockResolvedValue({
      status: 'available',
      fiveHour: { label: '5h', title: '5小时额度', value: '90%', percent: 90, resetsAt: 1 },
      sevenDay: { label: '7d', title: '7天额度', value: '80%', percent: 80, resetsAt: 2 },
      trayTitle: '5h 90%\n7d 80%',
      tooltip: '5小时额度 90%\n7天额度 80%',
    })
    getWegentUsageDisplayMock.mockResolvedValue({
      status: 'available',
      sourceText: 'AIGC额度',
      sourceLabel: 'AIGC',
      quota: 1042,
      usage: 1126.7,
      remaining: -84.7,
      usageRate: 108.13,
      value: '1,126.7 / 1,042 元',
      detail: '已用 108.13% · 剩余 -84.7 元',
      trayTitle: 'AIGC -84.7',
      tooltip: 'AIGC额度\n1,126.7 / 1,042 元 (108.13%)\n剩余 -84.7 元',
    })
  })

  test('checks for app updates from the settings menu', async () => {
    mockCheckNow.mockResolvedValue(null)

    renderMenu()

    await userEvent.click(screen.getByTestId('check-app-update-button'))

    expect(mockCheckNow).toHaveBeenCalledTimes(1)
  })

  test('uses subdued regular text for normal menu actions', () => {
    renderMenu()

    expect(screen.getByTestId('settings-menu-button')).toHaveClass(
      'font-normal',
      'text-text-primary'
    )
  })

  test('opens the About settings page from the menu', async () => {
    const onOpenAbout = vi.fn()
    renderMenu({ onOpenAbout })

    await userEvent.click(screen.getByTestId('about-menu-button'))

    expect(onOpenAbout).toHaveBeenCalledTimes(1)
  })

  test('does not render the old account or quota summary row', async () => {
    renderMenu()

    expect(screen.queryByTestId('settings-account-group')).not.toBeInTheDocument()
    expect(screen.queryByTestId('account-menu-button')).not.toBeInTheDocument()
    expect(screen.getByText('Codex 剩余额度')).toBeInTheDocument()
    expect(await screen.findByText('AIGC额度')).toBeInTheDocument()
  })

  test('hides logout in local-first app runtime', () => {
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(true)

    renderMenu()

    expect(screen.queryByTestId('logout-menu-button')).not.toBeInTheDocument()
    expect(screen.queryByText('退出登录')).not.toBeInTheDocument()
  })

  test('shows logout for a connected cloud account in local-first app runtime', async () => {
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(true)
    const onLogout = vi.fn()

    renderMenu({ showLogout: true, onLogout })

    await userEvent.click(screen.getByTestId('logout-menu-button'))

    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  test('shows a descriptive login action for a disconnected cloud account', async () => {
    const onLogin = vi.fn()

    renderMenu({ showLogout: false, onLogin })

    const loginButton = screen.getByTestId('login-menu-button')
    expect(loginButton).toHaveTextContent('登录 Wegent')
    expect(loginButton).toHaveTextContent('连接云端模型、设备和同步')
    expect(screen.queryByTestId('logout-menu-button')).not.toBeInTheDocument()

    await userEvent.click(loginButton)

    expect(onLogin).toHaveBeenCalledTimes(1)
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

  test('shows download progress in the update icon and menu item', () => {
    mockUpdateState = {
      ...mockUpdateState,
      availableUpdate: {
        currentVersion: '0.1.0',
        version: '0.1.1',
      },
      status: 'installing',
      downloadProgress: {
        downloadedBytes: 50,
        totalBytes: 100,
      },
    }

    renderMenu()

    expect(screen.getByTestId('app-update-download-icon-progress')).toHaveAttribute(
      'aria-label',
      '50%'
    )
    expect(screen.getByTestId('app-update-download-progress')).toHaveTextContent('正在下载更新 50%')
  })

  test('shows usage reset times in the expanded usage panel', async () => {
    renderMenu()

    await userEvent.click(screen.getByTestId('usage-menu-button'))

    expect(await screen.findByText('11:30 重置')).toBeInTheDocument()
    expect(screen.getByText('1月5日 09:15 重置')).toBeInTheDocument()
  })

  test('hides an unavailable five-hour quota without leaving an empty value row', async () => {
    getLocalCodexUsageDisplayMock.mockResolvedValue({
      status: 'available',
      fiveHour: {
        label: '5h',
        title: '5小时额度',
        value: '无',
        percent: null,
        resetsAt: null,
      },
      sevenDay: {
        label: '7d',
        title: '7天额度',
        value: '44%',
        percent: 44,
        resetsAt: 2,
      },
      trayTitle: '5h --\n7d 44%',
      tooltip: '5小时额度 无\n7天额度 44%',
    })

    renderMenu()
    await userEvent.click(screen.getByTestId('usage-menu-button'))

    expect(await screen.findByText('44%')).toBeInTheDocument()
    expect(screen.queryByText('5小时额度')).not.toBeInTheDocument()
    expect(screen.queryByText('无')).not.toBeInTheDocument()
  })

  test('keeps an exhausted five-hour quota visible', async () => {
    getLocalCodexUsageDisplayMock.mockResolvedValue({
      status: 'available',
      fiveHour: {
        label: '5h',
        title: '5小时额度',
        value: '0%',
        percent: 0,
        resetsAt: 1,
      },
      sevenDay: {
        label: '7d',
        title: '7天额度',
        value: '44%',
        percent: 44,
        resetsAt: 2,
      },
      trayTitle: '5h 0%\n7d 44%',
      tooltip: '5小时额度 0%\n7天额度 44%',
    })

    renderMenu()
    await userEvent.click(screen.getByTestId('usage-menu-button'))

    expect(await screen.findByText('5小时额度')).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
  })

  test('loads and displays the Wegent model quota', async () => {
    renderMenu()

    await userEvent.click(screen.getByTestId('wegent-usage-menu-button'))

    expect(getWegentUsageDisplayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        isConnected: true,
        apiBaseUrl: 'https://wegent.example.com/api',
        token: 'token',
      })
    )
    expect(await screen.findByText('1,126.7 / 1,042 元')).toBeInTheDocument()
    expect(screen.getByText('已用 108.13% · 剩余 -84.7 元')).toBeInTheDocument()
    expect(screen.getByText('1,126.7 / 1,042 元')).toHaveClass('break-words')
    expect(screen.getByText('已用 108.13% · 剩余 -84.7 元')).toHaveClass('break-words')
  })
})
