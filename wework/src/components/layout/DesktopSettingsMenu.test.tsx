import { getLocalCodexUsageDisplay } from '@/api/local/codexUsage'
import { getWegentUsageDisplay } from '@/api/wegentUsage'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import type { AppUpdateError } from '@/features/app-update/app-update-error'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import zh from '@/i18n/locales/zh-CN/common.json'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'

const translations = createInstance()
const mockCheckNow = vi.fn()
const mockInstallUpdate = vi.fn()
const runtimeModeMock = vi.hoisted(() => ({
  isLocalFirstAppRuntime: vi.fn(() => false),
}))
const cloudConnectionMock = vi.hoisted(() => ({
  isConnected: true,
  apiBaseUrl: 'https://wegent.example.com/api',
  token: 'token',
  serviceKey: 'service-one',
}))
let mockUpdateState = {
  availableUpdate: null as null | { currentVersion: string; version: string },
  status: 'idle',
  downloadProgress: null as null | { downloadedBytes: number; totalBytes: number | null },
  error: null as AppUpdateError | null,
  checkNow: mockCheckNow,
  installUpdate: mockInstallUpdate,
}

vi.mock('@/features/app-update/app-update-context', () => ({
  useOptionalAppUpdate: () => mockUpdateState,
}))

vi.mock('@/lib/runtime-mode', () => runtimeModeMock)

vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => cloudConnectionMock,
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
  localCodexSubscriptionEnabled,
}: {
  showLogout?: boolean
  onLogout?: () => void
  onLogin?: () => void
  onOpenAbout?: () => void
  localCodexSubscriptionEnabled?: boolean
} = {}) {
  const menu = (
    <DesktopSettingsMenu
      user={{ id: 1, email: 'user@example.com', user_name: 'User' }}
      onOpenSettings={vi.fn()}
      onOpenAbout={onOpenAbout}
      onLogout={onLogout}
      onLogin={onLogin}
      showLogout={showLogout}
    />
  )
  return render(
    <I18nextProvider i18n={translations}>
      {localCodexSubscriptionEnabled === undefined ? (
        menu
      ) : (
        <AppPreferencesContext.Provider
          value={{
            loaded: true,
            preferences: { ...defaultAppPreferences, localCodexSubscriptionEnabled },
          }}
        >
          {menu}
        </AppPreferencesContext.Provider>
      )}
    </I18nextProvider>
  )
}

describe('DesktopSettingsMenu', () => {
  beforeEach(async () => {
    await translations.init({ lng: 'zh-CN', resources: { 'zh-CN': { common: zh } } })
    vi.clearAllMocks()
    Object.assign(cloudConnectionMock, {
      isConnected: true,
      token: 'token',
      serviceKey: 'service-one',
    })
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

  test('shows download progress in the update icon and menu item', () => {
    mockUpdateState = {
      ...mockUpdateState,
      availableUpdate: {
        currentVersion: '0.1.0',
        version: '0.1.1',
      },
      status: 'downloading',
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

  test('shows a compact network error and opens sanitized diagnostics', async () => {
    const checkNow = vi.fn().mockResolvedValue(null)
    mockUpdateState = {
      ...mockUpdateState,
      status: 'error',
      error: {
        stage: 'check',
        kind: 'network',
        code: 'APP_UPDATE_NETWORK_UNAVAILABLE',
        occurredAt: Date.parse('2026-08-31T02:22:00Z'),
        detail: null,
      },
      checkNow,
    }

    renderMenu()

    const status = screen.getByTestId('app-update-status')
    expect(status).toHaveTextContent('网络不可用，无法检查更新')
    expect(status).toHaveTextContent('查看错误详情')
    expect(status).not.toHaveTextContent('<html')
    expect(status).not.toHaveClass('text-red-400')

    await userEvent.click(screen.getByTestId('app-update-error-details-button'))

    const dialog = screen.getByTestId('app-update-error-dialog')
    expect(dialog).toHaveTextContent('网络连接失败')
    expect(dialog).toHaveTextContent('APP_UPDATE_NETWORK_UNAVAILABLE')
    expect(dialog).toHaveTextContent('检查应用更新')
    expect(dialog).not.toHaveTextContent('https://')
    await waitFor(() => {
      expect(screen.getByTestId('app-update-error-dialog-close')).toHaveFocus()
    })

    await userEvent.click(screen.getByTestId('app-update-error-retry'))

    expect(checkNow).toHaveBeenCalledTimes(1)
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
  test('does not duplicate an in-flight preload when expanding quota', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getWegentUsageDisplay>>) => void
    const value = await getWegentUsageDisplayMock.getMockImplementation()!({
      ...cloudConnectionMock,
    })
    getWegentUsageDisplayMock.mockImplementationOnce(
      () =>
        new Promise(accept => {
          resolve = accept
        })
    )
    getWegentUsageDisplayMock.mockClear()
    renderMenu()
    fireEvent.click(screen.getByTestId('wegent-usage-menu-button'))
    expect(getWegentUsageDisplayMock).toHaveBeenCalledOnce()
    await act(async () => resolve(value))
    expect(screen.getByText(value.value)).toBeInTheDocument()
  })

  test('isolates a replacement cloud connection from the previous pending quota response', async () => {
    const value = await getWegentUsageDisplayMock.getMockImplementation()!({
      ...cloudConnectionMock,
    })
    let resolveOld!: (result: typeof value) => void
    getWegentUsageDisplayMock.mockImplementationOnce(
      () =>
        new Promise(accept => {
          resolveOld = accept
        })
    )
    const { rerender } = renderMenu()
    fireEvent.click(screen.getByTestId('wegent-usage-menu-button'))
    cloudConnectionMock.token = 'replacement-token'
    cloudConnectionMock.serviceKey = 'service-two'
    getWegentUsageDisplayMock.mockResolvedValue({ ...value, value: 'New account quota' })
    rerender(
      <I18nextProvider i18n={translations}>
        <DesktopSettingsMenu
          user={null}
          onOpenSettings={vi.fn()}
          onOpenAbout={vi.fn()}
          onLogout={vi.fn()}
        />
      </I18nextProvider>
    )
    expect(await screen.findByText('New account quota')).toBeInTheDocument()
    await act(async () => resolveOld(value))
    expect(screen.getByText('New account quota')).toBeInTheDocument()
    expect(screen.queryByText(value.value)).not.toBeInTheDocument()
  })

  test('does not load quota while disconnected, including after expansion', () => {
    cloudConnectionMock.isConnected = false
    renderMenu()
    fireEvent.click(screen.getByTestId('wegent-usage-menu-button'))
    expect(getWegentUsageDisplayMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('wegent-usage-detail-panel')).toHaveTextContent('登录 Wegent')
  })
})
