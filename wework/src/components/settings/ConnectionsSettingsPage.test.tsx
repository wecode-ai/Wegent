import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ConnectionsSettingsPage } from './ConnectionsSettingsPage'
import { createDeviceApi } from '@/api/devices'
import { AppearanceProvider } from '@/features/appearance'
import type { DeviceInfo } from '@/types/devices'

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({ apiBaseUrl: '/api' }),
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(() => ({})),
}))

vi.mock('@/api/devices', () => ({
  createDeviceApi: vi.fn(),
}))

const createDeviceApiMock = vi.mocked(createDeviceApi)

function cloudDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'yunpeng7-executor-device-1',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.712',
    cloud_config: {
      sandboxId: 'sandbox-1',
    },
    ...overrides,
  }
}

describe('ConnectionsSettingsPage', () => {
  const api = {
    getAllDevices: vi.fn(),
    startTerminal: vi.fn(),
    startCodeServer: vi.fn(),
    createCloudDevice: vi.fn(),
    renameDevice: vi.fn(),
    restartCloudDevice: vi.fn(),
    deleteCloudDevice: vi.fn(),
    getMetrics: vi.fn(),
    getMetricsHistory: vi.fn(),
    getVncConfig: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    api.getMetrics.mockResolvedValue({
      cpu_usage: 42,
      memory_usage: 68,
      disk_usage: 57,
    })
    api.getMetricsHistory.mockResolvedValue({
      cpu: [],
      memory: [],
      disk: [],
    })
    api.getVncConfig.mockResolvedValue({
      wss_url: 'wss://example.com/vnc',
      signature: 'signature',
      sandbox_id: 'sandbox-1',
    })
    createDeviceApiMock.mockReturnValue(api)
  })

  test('keeps the cloud device creation notice visible after the create request resolves', async () => {
    api.getAllDevices.mockResolvedValue([])
    api.createCloudDevice.mockResolvedValue({
      id: 1,
      device_id: 'device-1',
      name: 'yunpeng7-executor-device-1',
      status: 'offline',
      device_type: 'cloud',
      message: 'created',
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('connection-add-device-button'))
    const createDialog = screen.getByTestId('add-cloud-device-dialog')
    expect(createDialog.querySelector('.text-\\[\\#0d9488\\]')).toBeNull()
    expect(screen.getByTestId('add-cloud-device-confirm')).toHaveClass('bg-[#409eff]')
    await userEvent.click(screen.getByTestId('add-cloud-device-confirm'))

    await waitFor(() => expect(api.createCloudDevice).toHaveBeenCalledTimes(1))
    const creatingNotice = screen.getByText(
      '云设备创建中，初始化约需 2-3 分钟，完成后将自动出现在列表中',
    )
    expect(creatingNotice).toHaveClass('text-primary')
  })

  test('opens appearance settings from desktop settings navigation', async () => {
    api.getAllDevices.mockResolvedValue([])

    render(
      <AppearanceProvider>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>,
    )

    await userEvent.click(screen.getByTestId('settings-nav-appearance'))

    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-mode-system')).toBeInTheDocument()
  })

  test('keeps uncommon cloud device actions in a compact more menu with confirmation', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice()])
    api.restartCloudDevice.mockResolvedValue({ message: 'restart sent' })
    api.deleteCloudDevice.mockResolvedValue({ message: 'deleted' })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    expect(screen.queryByTestId('connection-restart-button-device-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-delete-button-device-1')).not.toBeInTheDocument()

    const moreButton = screen.getByTestId('connection-more-button-device-1')
    expect(moreButton).toHaveClass('h-7', 'w-7')
    expect(moreButton).toHaveAccessibleName('更多操作')

    await userEvent.click(moreButton)
    const restartMenuItem = screen.getByTestId('connection-restart-menu-item-device-1')
    const deleteMenuItem = screen.getByTestId('connection-delete-menu-item-device-1')
    expect(restartMenuItem).toHaveTextContent('重启设备')
    expect(deleteMenuItem).toHaveTextContent('删除设备')

    await userEvent.click(restartMenuItem)
    expect(api.restartCloudDevice).not.toHaveBeenCalled()
    const restartDialog = screen.getByTestId('confirm-restart-device-dialog')
    const restartConfirmButton = screen.getByTestId('confirm-restart-device-button')
    expect(restartDialog.querySelector('.text-\\[\\#0d9488\\]')).toBeNull()
    expect(restartConfirmButton).toHaveClass('bg-[#2d2d2d]')
    await userEvent.click(restartConfirmButton)

    await userEvent.click(moreButton)
    await userEvent.click(screen.getByTestId('connection-delete-menu-item-device-1'))
    expect(api.deleteCloudDevice).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('confirm-delete-device-button'))

    expect(api.restartCloudDevice).toHaveBeenCalledWith('device-1')
    expect(api.deleteCloudDevice).toHaveBeenCalledWith('device-1')
  })

  test('only lists cloud Claude Code devices', async () => {
    api.getAllDevices.mockResolvedValue([
      cloudDevice({
        device_id: 'cloud-claude',
        name: 'Cloud Claude Device',
        device_type: 'cloud',
        bind_shell: 'claudecode',
      }),
      cloudDevice({
        device_id: 'cloud-openclaw',
        name: 'Cloud OpenClaw Device',
        device_type: 'cloud',
        bind_shell: 'openclaw',
      }),
      cloudDevice({
        device_id: 'local-claude',
        name: 'Local Claude Device',
        device_type: 'local',
        bind_shell: 'claudecode',
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByText('Cloud Claude Device')).toBeInTheDocument()
    expect(screen.queryByText('Cloud OpenClaw Device')).not.toBeInTheDocument()
    expect(screen.queryByText('Local Claude Device')).not.toBeInTheDocument()
  })
})
