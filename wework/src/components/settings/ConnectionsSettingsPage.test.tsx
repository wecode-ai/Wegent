import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ConnectionsSettingsPage } from './ConnectionsSettingsPage'
import { createDeviceApi } from '@/api/devices'
import { createProjectApi } from '@/api/projects'
import { createUserApi } from '@/api/users'
import { AppearanceProvider } from '@/features/appearance'
import '@/i18n'
import type { DeviceInfo } from '@/types/devices'

const runtimeConfigMock = vi.hoisted(() => ({
  value: {
    appBasePath: '',
    apiBaseUrl: '/api',
    cloudDeviceScalingWikiUrl: '',
  },
}))

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => runtimeConfigMock.value,
  stripAppBasePath: (path: string) => path,
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(() => ({})),
}))

vi.mock('@/api/devices', () => ({
  createDeviceApi: vi.fn(),
}))

vi.mock('@/api/projects', () => ({
  createProjectApi: vi.fn(),
}))

vi.mock('@/api/users', () => ({
  createUserApi: vi.fn(),
}))

const createDeviceApiMock = vi.mocked(createDeviceApi)
const createProjectApiMock = vi.mocked(createProjectApi)
const createUserApiMock = vi.mocked(createUserApi)

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

function localDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return cloudDevice({
    id: 2,
    device_id: 'local-device',
    name: 'Local Claude Device',
    device_type: 'local',
    bind_shell: 'claudecode',
    cloud_config: undefined,
    ...overrides,
  })
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
    deleteDevice: vi.fn(),
    getMetrics: vi.fn(),
    getMetricsHistory: vi.fn(),
    getVncConfig: vi.fn(),
  }
  const projectApi = {
    listWorktrees: vi.fn(),
    deleteWorktree: vi.fn(),
  }
  const userApi = {
    updateCurrentUser: vi.fn(),
    getRuntimeConfig: vi.fn(),
    updateRuntimeConfig: vi.fn(),
    uploadRuntimeAuthJson: vi.fn(),
    importRuntimeAuthJson: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    runtimeConfigMock.value = {
      appBasePath: '',
      apiBaseUrl: '/api',
      cloudDeviceScalingWikiUrl: '',
    }
    window.history.pushState({}, '', '/')
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
    projectApi.listWorktrees.mockResolvedValue({ total: 0, devices: [] })
    projectApi.deleteWorktree.mockResolvedValue({
      worktree_id: '1386',
      path: '/workspace/worktrees/1386/Wegent',
      deleted_task_ids: [],
    })
    createProjectApiMock.mockReturnValue(projectApi as ReturnType<typeof createProjectApi>)
    userApi.getRuntimeConfig.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      updated_at: '2026-06-09T00:00:00Z',
    })
    userApi.updateRuntimeConfig.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: true,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      updated_at: '2026-06-09T00:00:01Z',
    })
    userApi.uploadRuntimeAuthJson.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      updated_at: '2026-06-09T00:00:00Z',
    })
    userApi.importRuntimeAuthJson.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      updated_at: '2026-06-09T00:00:00Z',
    })
    createUserApiMock.mockReturnValue(userApi as ReturnType<typeof createUserApi>)
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
    expect(createDialog).toHaveClass('bg-popover')
    expect(screen.getByTestId('add-cloud-device-confirm')).toHaveClass('bg-primary')
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

  test('opens Codex auth settings under personal group without manual device sync', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('settings-category-personal')).toHaveTextContent('个人')

    await userEvent.click(screen.getByTestId('settings-nav-codex-auth'))

    expect(await screen.findByTestId('runtime-config-settings-page')).toBeInTheDocument()
    expect(await screen.findByTestId('runtime-config-status')).toHaveTextContent('已配置')
    expect(
      screen.getByText(
        '从设备导入或上传 Codex auth.json。启用后，使用 Codex 的 GPT 模型会通过该认证账户访问 Codex。',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('~/.codex/auth.json')).toBeInTheDocument()
    const runtimeConfigButtons = Array.from(
      screen.getByTestId('runtime-config-settings-page').querySelectorAll('button'),
    )
    expect(
      runtimeConfigButtons.indexOf(screen.getByTestId('runtime-config-import-button')),
    ).toBeLessThan(
      runtimeConfigButtons.indexOf(screen.getByTestId('runtime-config-upload-button')),
    )

    await userEvent.click(screen.getByTestId('runtime-config-toggle'))

    await waitFor(() =>
      expect(userApi.updateRuntimeConfig).toHaveBeenCalledWith('codex', {
        use_user_config: true,
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-config-toggle')).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    )

    expect(screen.queryByTestId('runtime-config-sync-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-sync-result')).not.toBeInTheDocument()
  })

  test('opens worktree settings from the coding settings navigation', async () => {
    api.getAllDevices.mockResolvedValue([])
    projectApi.listWorktrees.mockResolvedValue({
      total: 2,
      devices: [
        {
          device_id: 'device-1',
          device_name: 'Crystal Mac',
          device_status: 'online',
          available: true,
          items: [
            {
              worktree_id: '1386',
              project_name: 'Wegent',
              path: '/workspace/worktrees/1386/Wegent',
              project: {
                id: 7,
                name: 'Wegent',
                source_path: 'd837/Wegent',
              },
              task: {
                id: 1386,
                title: 'Fix sidebar persistence',
                status: 'RUNNING',
                project_id: 7,
              },
            },
          ],
        },
        {
          device_id: 'device-2',
          device_name: 'Linux Builder',
          device_status: 'offline',
          available: true,
          items: [
            {
              worktree_id: '1387',
              project_name: 'Wegent',
              path: '/workspace/worktrees/1387/Wegent',
              project: {
                id: 7,
                name: 'Wegent',
                source_path: 'd837/Wegent',
              },
              task: null,
            },
          ],
        },
      ],
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-worktrees'))

    expect(screen.getByTestId('worktrees-settings-page')).toBeInTheDocument()
    expect(screen.getByText('编码')).toBeInTheDocument()
    expect(screen.getByTestId('worktrees-refresh-button')).toHaveAccessibleName('刷新')
    expect(screen.getByTestId('worktrees-refresh-button')).not.toHaveTextContent('刷新')
    const projectGroup = await screen.findByTestId('worktree-project-group')
    expect(projectGroup).toHaveTextContent('Wegent')
    const metadata = within(projectGroup).getByTestId('worktree-project-metadata')
    expect(metadata).toHaveTextContent('d837/Wegent')
    expect(metadata).toHaveTextContent('Crystal Mac')
    expect(metadata).toHaveTextContent('Linux Builder')
    expect(await screen.findByText('/workspace/worktrees/1386/Wegent')).toBeInTheDocument()
    expect(screen.getByText('/workspace/worktrees/1387/Wegent')).toBeInTheDocument()
    expect(screen.getByTestId('worktree-task-link-1386')).toHaveTextContent(
      'Fix sidebar persistence',
    )
    expect(screen.getByTestId('worktree-task-missing-1387')).toHaveTextContent(
      '未关联会话',
    )
    expect(screen.getByText('Crystal Mac')).toHaveClass('text-text-muted')
    expect(screen.getByText('Linux Builder')).toHaveClass('text-text-muted')
    within(projectGroup).getAllByTestId('worktree-row').forEach(row => {
      expect(row).not.toHaveTextContent('Crystal Mac')
      expect(row).not.toHaveTextContent('Linux Builder')
    })
    expect(screen.queryByText('device-1')).not.toBeInTheDocument()
    expect(screen.queryByText('1386')).not.toBeInTheDocument()
    expect(screen.queryByTestId('worktree-device-device-1')).not.toBeInTheDocument()
    expect(projectApi.listWorktrees).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('worktree-task-link-1386'))

    expect(window.location.pathname).toBe('/projects/7/tasks/1386')
  })

  test('shows a single empty worktree state without device groups', async () => {
    api.getAllDevices.mockResolvedValue([])
    projectApi.listWorktrees.mockResolvedValue({
      total: 0,
      devices: [
        {
          device_id: 'device-empty',
          device_name: 'Empty Device',
          device_status: 'online',
          available: true,
          items: [],
        },
      ],
    })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-worktrees'))

    expect(await screen.findByText('尚无工作树')).toBeInTheDocument()
    expect(screen.getByText('创建的工作树将显示在此处。')).toHaveClass('text-text-secondary')
    expect(screen.queryByText('此设备暂无工作树')).not.toBeInTheDocument()
    expect(screen.queryByText('Empty Device')).not.toBeInTheDocument()
  })

  test('deletes a worktree from the worktree settings page', async () => {
    api.getAllDevices.mockResolvedValue([])
    projectApi.listWorktrees
      .mockResolvedValueOnce({
        total: 1,
        devices: [
          {
            device_id: 'device-1',
            device_name: 'Crystal Mac',
            device_status: 'online',
            available: true,
            items: [
              {
                worktree_id: '1386',
                project_name: 'Wegent',
                path: '/workspace/worktrees/1386/Wegent',
                project: {
                  id: 7,
                  name: 'Wegent',
                  source_path: 'd837/Wegent',
                },
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({ total: 0, devices: [] })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-worktrees'))
    await userEvent.click(await screen.findByTestId('delete-worktree-button-1386'))

    expect(screen.getByTestId('confirm-delete-worktree-dialog')).toHaveTextContent(
      '将删除这个工作树目录，并一并删除使用该工作树的任务。',
    )

    await userEvent.click(screen.getByTestId('confirm-delete-worktree-button'))

    await waitFor(() =>
      expect(projectApi.deleteWorktree).toHaveBeenCalledWith({
        device_id: 'device-1',
        worktree_id: '1386',
        project_id: 7,
      }),
    )
    expect(projectApi.listWorktrees).toHaveBeenCalledTimes(2)
  })

  test('opens appearance settings from the browser path on reload', () => {
    api.getAllDevices.mockResolvedValue([])
    window.history.pushState({}, '', '/settings/appearance')

    render(
      <AppearanceProvider>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>,
    )

    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-appearance')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]',
    )
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
    expect(restartDialog).toHaveClass('bg-popover')
    expect(restartConfirmButton).toHaveClass('bg-text-primary', 'text-background')
    await userEvent.click(restartConfirmButton)

    await userEvent.click(moreButton)
    await userEvent.click(screen.getByTestId('connection-delete-menu-item-device-1'))
    expect(api.deleteCloudDevice).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('confirm-delete-device-button'))

    expect(api.restartCloudDevice).toHaveBeenCalledWith('device-1')
    expect(api.deleteCloudDevice).toHaveBeenCalledWith('device-1')
  })

  test('lists local and cloud Claude Code devices while excluding unsupported shells', async () => {
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
      localDevice({
        device_id: 'local-claude',
        name: 'Local Claude Device',
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByText('Cloud Claude Device')).toBeInTheDocument()
    expect(screen.getByText('Local Claude Device')).toBeInTheDocument()
    expect(screen.queryByText('Cloud OpenClaw Device')).not.toBeInTheDocument()
  })

  test('uses theme-aware surfaces for device cards and controls', async () => {
    api.getAllDevices.mockResolvedValue([cloudDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const deviceCard = await screen.findByTestId('connection-device-device-1')
    const terminalButton = screen.getByTestId('connection-terminal-button-device-1')
    const moreButton = screen.getByTestId('connection-more-button-device-1')

    expect(deviceCard).toHaveClass('bg-surface', 'border-border')
    expect(deviceCard).not.toHaveClass('bg-white')
    expect(terminalButton).toHaveClass('bg-background', 'text-text-primary')
    expect(moreButton).toHaveClass('bg-background', 'text-text-secondary')
  })

  test('hides cloud-only actions and metrics for local devices', async () => {
    api.getAllDevices.mockResolvedValue([
      localDevice({
        device_id: 'local-claude',
        name: 'Local Claude Device',
      }),
    ])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-device-local-claude')).toBeInTheDocument()
    expect(screen.getByText('Local Claude Device')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-terminal-button-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-code-server-button-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-vnc-button-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-more-button-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-delete-button-local-claude')).not.toBeInTheDocument()
    expect(screen.queryByTestId('device-metrics')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-scale-wiki')).not.toBeInTheDocument()
    expect(api.getMetrics).not.toHaveBeenCalled()
  })

  test('shows configured cloud device scaling wiki link in the cloud section guidance', async () => {
    runtimeConfigMock.value = {
      appBasePath: '',
      apiBaseUrl: '/api',
      cloudDeviceScalingWikiUrl: 'https://wiki.example.com/cloud-device-scaling',
    }
    api.getAllDevices.mockResolvedValue([cloudDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await screen.findByTestId('connection-device-device-1')
    const link = screen.getByTestId('connection-scale-wiki-link')

    expect(link).toHaveTextContent('详细见Wiki')
    expect(link).toHaveAttribute('href', 'https://wiki.example.com/cloud-device-scaling')
    expect(link).toHaveClass('text-text-secondary', 'hover:text-primary')
    expect(link).toHaveClass('ml-2')
    expect(link.closest('p')).toHaveTextContent('持续超过 80%')
  })

  test('allows deleting offline local device registrations', async () => {
    api.getAllDevices.mockResolvedValue([
      localDevice({
        device_id: 'offline-local',
        name: 'Offline Local Device',
        status: 'offline',
      }),
    ])
    api.deleteDevice.mockResolvedValue({ message: 'deleted' })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(await screen.findByTestId('connection-device-offline-local')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-more-button-offline-local')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('connection-delete-button-offline-local'))
    expect(screen.getByTestId('confirm-delete-device-dialog')).toHaveTextContent('删除本地设备')
    expect(screen.getByTestId('confirm-delete-device-dialog')).toHaveTextContent(
      '本地设备注册记录',
    )
    await userEvent.click(screen.getByTestId('confirm-delete-device-button'))

    await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('offline-local'))
    expect(api.deleteCloudDevice).not.toHaveBeenCalled()
  })
})
