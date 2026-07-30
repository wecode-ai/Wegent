import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { CloudWorkPage } from './CloudWorkPage'
import { navigateTo } from '@/lib/navigation'
import { requestProjectCreateMode } from '@/components/layout/workbenchShellEvents'

const workbenchMock = vi.hoisted(() => ({
  value: {
    state: {
      user: { id: 1, user_name: 'alice', preferences: {} },
      projects: [],
      devices: [
        {
          id: 1,
          device_id: 'local-device',
          name: 'Local',
          status: 'online',
          device_type: 'local',
        },
        {
          id: 2,
          device_id: 'cloud-device',
          name: 'Cloud Box',
          status: 'online',
          device_type: 'cloud',
        },
      ],
      runtimeWork: {
        projects: [
          {
            project: {
              key: 'cloud-project',
              id: 21,
              name: 'Cloud Project',
              stateDeviceId: 'cloud-device',
            },
            deviceWorkspaces: [
              {
                deviceId: 'cloud-device',
                deviceName: 'Cloud Box',
                available: true,
                workspacePath: '/workspace/cloud-project',
              },
            ],
          },
          {
            project: {
              key: 'local-project',
              id: 22,
              name: 'Local Project',
              stateDeviceId: 'local-device',
            },
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                deviceName: 'Local',
                available: true,
                workspacePath: '/workspace/local-project',
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
      currentProject: null,
      currentRuntimeTask: null,
      standaloneDeviceId: null,
      standaloneWorkspacePath: null,
    },
    cloudWorkStatus: {
      availability: 'available',
      checks: {
        teams: 'available',
        devices: 'available',
        runtimeWork: 'available',
      },
      error: null,
      updatedAt: null,
    },
    selectProject: vi.fn(),
    startNewChat: vi.fn(),
    startStandaloneChat: vi.fn(),
    startNewProjectChat: vi.fn(),
    openRuntimeTask: vi.fn(),
    renameRuntimeTask: vi.fn(),
    archiveRuntimeTask: vi.fn(),
    archiveProjectConversations: vi.fn(),
    archiveProjectsConversations: vi.fn(),
    archiveChatConversations: vi.fn(),
    selectStandaloneDevice: vi.fn(),
    openStandaloneWorkspace: vi.fn(),
    getRemoteDeviceStartupCommand: vi.fn(),
    refreshDevices: vi.fn().mockResolvedValue(undefined),
    createProject: vi.fn(),
    createGitWorkspaceProject: vi.fn(),
    prepareDeviceWorkspace: vi.fn(),
    deleteDeviceWorkspace: vi.fn(),
    searchRuntimeWork: vi.fn(),
    listGitRepositories: vi.fn(),
    listGitBranches: vi.fn(),
    updateProjectName: vi.fn(),
    removeProject: vi.fn(),
    getDeviceHomeDirectory: vi.fn(),
    getProjectWorkspaceRoot: vi.fn(),
    listDeviceDirectories: vi.fn(),
    createDeviceDirectory: vi.fn(),
  },
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => workbenchMock.value,
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({ logout: vi.fn() }),
}))

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/components/layout/useDesktopSidebarCollapsed', () => ({
  useDesktopSidebarCollapsed: () => ({
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
  }),
}))

vi.mock('@/components/layout/DesktopWindowsTitlebar', () => ({
  DesktopWindowsTitlebar: () => null,
}))

vi.mock('@/components/layout/DesktopSidebar', () => ({
  DesktopSidebar: () => <aside data-testid="desktop-sidebar" />,
}))

vi.mock('@/components/layout/WorkbenchSearchDialog', () => ({
  WorkbenchSearchDialog: () => null,
}))

vi.mock('@/components/settings/ConnectionsSettingsPage', () => ({
  DeviceSection: ({ devices }: { devices: Array<{ device_id: string }> }) => (
    <div data-testid="cloud-device-section">
      {devices.map(device => (
        <span key={device.device_id}>{device.device_id}</span>
      ))}
    </div>
  ),
}))

vi.mock('@/lib/navigation', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/navigation')>()
  return {
    ...original,
    navigateTo: vi.fn(),
  }
})

vi.mock('@/components/layout/workbenchShellEvents', () => ({
  requestProjectCreateMode: vi.fn(),
}))

describe('CloudWorkPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('shows cloud devices and cloud projects without local resources', () => {
    render(<CloudWorkPage />)

    expect(screen.getByTestId('cloud-work-page')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-device-section')).toHaveTextContent('cloud-device')
    expect(screen.getByTestId('cloud-device-section')).not.toHaveTextContent('local-device')
    expect(screen.getByText('Cloud Project')).toBeInTheDocument()
    expect(screen.queryByText('Local Project')).not.toBeInTheDocument()
    expect(screen.getByText('Cloud Box · /workspace/cloud-project')).toBeInTheDocument()
  })

  test('opens a cloud project in the standard workbench', async () => {
    render(<CloudWorkPage />)

    await userEvent.click(screen.getByTestId('cloud-work-project-21'))

    expect(navigateTo).toHaveBeenCalledWith('/')
    expect(workbenchMock.value.selectProject).toHaveBeenCalledWith(21)
  })

  test('keeps device setup and project creation in their existing flows', async () => {
    render(<CloudWorkPage />)

    await userEvent.click(screen.getByTestId('cloud-work-add-device-button'))
    expect(navigateTo).toHaveBeenCalledWith('/settings/connections?addDevice=1')

    await userEvent.click(screen.getByTestId('cloud-work-create-project-button'))
    expect(navigateTo).toHaveBeenCalledWith('/')
    expect(requestProjectCreateMode).toHaveBeenCalledWith('git')
  })

  test('opens cloud connection settings only from the explicit settings action', async () => {
    render(<CloudWorkPage />)

    await userEvent.click(screen.getByTestId('cloud-work-settings-button'))

    expect(navigateTo).toHaveBeenCalledWith('/settings/connections')
  })
})
