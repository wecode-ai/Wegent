import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { preloadDefaultDshUiTestModules } from '@/test/setup.dom'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { installGitUiTestContributions } from '../../ui-git/test-support'
import { CloudWorkPage } from './CloudWorkPage'

const sidebarMock = vi.hoisted(() => ({ renderReal: false }))

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
          bind_shell: 'claudecode',
          executor_version: '1.8.5',
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
                tasks: [],
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
                tasks: [],
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
    cloneGitRepository: vi.fn(),
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

vi.mock('@/components/layout/DesktopSidebar', async importOriginal => {
  const { DesktopSidebar } =
    await importOriginal<typeof import('@/components/layout/DesktopSidebar')>()
  return {
    DesktopSidebar: (props: Parameters<typeof DesktopSidebar>[0]) =>
      sidebarMock.renderReal ? (
        <DesktopSidebar {...props} />
      ) : (
        <aside data-testid="desktop-sidebar" />
      ),
  }
})

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

await preloadDefaultDshUiTestModules()

describe('CloudWorkPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    sidebarMock.renderReal = false
    await preloadDefaultDshUiTestModules()
    await installGitUiTestContributions()
  }, 60_000)

  test('clones from the cloud work sidebar and recovers from a clone failure', async () => {
    sidebarMock.renderReal = true
    let rejectClone!: (error: Error) => void
    const clonePending = new Promise<void>((_resolve, reject) => {
      rejectClone = reject
    })
    workbenchMock.value.getDeviceHomeDirectory.mockResolvedValue('/home/ubuntu')
    workbenchMock.value.cloneGitRepository
      .mockReturnValueOnce(clonePending)
      .mockResolvedValueOnce(undefined)
    const store = new RuntimeTaskLifecycleStore('cloud-work-project-clone')
    render(
      <RuntimeTaskLifecycleProvider store={store}>
        <CloudWorkPage />
      </RuntimeTaskLifecycleProvider>
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))
    await userEvent.click(screen.getByTestId('remote-project-source-git'))
    await waitFor(() =>
      expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/home/ubuntu')
    )
    const url = 'ssh://git@git.example.com:2222/team/repository.git'
    await userEvent.type(screen.getByTestId('remote-project-git-url-input'), url)
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))

    expect(workbenchMock.value.cloneGitRepository).toHaveBeenCalledWith('cloud-device', {
      url,
      targetPath: '/home/ubuntu/repository',
    })
    expect(screen.getByTestId('remote-project-git-submit')).toBeDisabled()
    expect(workbenchMock.value.openStandaloneWorkspace).not.toHaveBeenCalled()

    await act(async () => rejectClone(new Error('SSH authentication failed')))
    expect(await screen.findByTestId('remote-project-git-error')).toHaveTextContent(
      'SSH authentication failed'
    )
    expect(screen.getByTestId('remote-project-git-url-input')).toHaveValue(url)
    expect(screen.getByTestId('remote-project-git-submit')).toBeEnabled()
    expect(workbenchMock.value.openStandaloneWorkspace).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    await waitFor(() =>
      expect(workbenchMock.value.openStandaloneWorkspace).toHaveBeenCalledWith(
        'cloud-device',
        '/home/ubuntu/repository',
        'repository'
      )
    )
    expect(workbenchMock.value.cloneGitRepository).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
  }, 15_000)
})
