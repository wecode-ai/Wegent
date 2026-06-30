import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createProjectApi } from '@/api/projects'
import { openExternalUrl } from '@/lib/external-links'
import { isLocalTerminalAvailable, openLocalWorkspace } from '@/lib/local-terminal'
import { WorkspacePanelActions } from './WorkspacePanelActions'

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({ appBasePath: '', apiBaseUrl: '/api' }),
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(() => ({})),
}))

vi.mock('@/api/projects', () => ({
  createProjectApi: vi.fn(),
}))

vi.mock('@/lib/local-terminal', () => ({
  isLocalTerminalAvailable: vi.fn(),
  openLocalWorkspace: vi.fn(),
}))

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

const createProjectApiMock = vi.mocked(createProjectApi)
const openExternalUrlMock = vi.mocked(openExternalUrl)
const isLocalTerminalAvailableMock = vi.mocked(isLocalTerminalAvailable)
const openLocalWorkspaceMock = vi.mocked(openLocalWorkspace)
const startCodeServerSessionMock = vi.fn()

const baseProps = {
  environmentInfo: {
    additions: '+0',
    deletions: '-0',
    executionTarget: 'local' as const,
  },
  onRefreshEnvironmentInfo: vi.fn(),
  onCommitEnvironmentChanges: vi.fn(),
  onListEnvironmentBranches: vi.fn(),
  onCheckoutEnvironmentBranch: vi.fn(),
  onCreateEnvironmentBranch: vi.fn(),
  onOpenEnvironmentChangesReview: vi.fn(),
  rightPanelOpen: false,
  bottomPanelOpen: false,
  onToggleRightPanel: vi.fn(),
  onToggleBottomPanel: vi.fn(),
}

describe('WorkspacePanelActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isLocalTerminalAvailableMock.mockReturnValue(false)
    openLocalWorkspaceMock.mockResolvedValue(undefined)
    startCodeServerSessionMock.mockResolvedValue({
      url: 'http://localhost/ide',
      path: '/workspace/project',
    })
    createProjectApiMock.mockReturnValue({
      startCodeServerSession: startCodeServerSessionMock,
    } as unknown as ReturnType<typeof createProjectApi>)
    openExternalUrlMock.mockResolvedValue(true)
  })

  test('shows environment info while loading and keeps it when environment context is available', () => {
    const { rerender } = render(<WorkspacePanelActions {...baseProps} />)

    expect(screen.getByTestId('environment-info-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()

    rerender(
      <WorkspacePanelActions
        {...baseProps}
        environmentInfo={{
          ...baseProps.environmentInfo,
          loading: false,
        }}
      />
    )

    expect(screen.queryByTestId('environment-info-button')).not.toBeInTheDocument()

    rerender(
      <WorkspacePanelActions
        {...baseProps}
        environmentInfo={{
          ...baseProps.environmentInfo,
          loading: false,
          deviceId: 'device-1',
          workspacePath: '/workspace/project',
        }}
      />
    )

    expect(screen.getByTestId('environment-info-button')).toBeInTheDocument()

    rerender(
      <WorkspacePanelActions
        {...baseProps}
        environmentInfo={{
          ...baseProps.environmentInfo,
          loading: false,
          branchName: 'main',
        }}
      />
    )

    expect(screen.getByTestId('environment-info-button')).toBeInTheDocument()
  })

  test('opens local workspaces with the default VS Code titlebar action', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(true)
    render(
      <WorkspacePanelActions
        {...baseProps}
        currentProject={{
          id: 7,
          name: 'project38',
          config: {
            execution: {
              targetType: 'local',
              deviceId: 'device-1',
            },
            workspace: {
              source: 'local_path',
              localPath: '/Users/me/project38',
            },
          },
          tasks: [],
        }}
        devices={[
          {
            id: 1,
            device_id: 'device-1',
            name: 'Local Device',
            status: 'online',
            is_default: false,
            device_type: 'local',
            bind_shell: 'claudecode',
          },
        ]}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    expect(openLocalWorkspaceMock).toHaveBeenCalledWith({
      opener: 'vscode',
      path: '/Users/me/project38',
    })
    expect(startCodeServerSessionMock).not.toHaveBeenCalled()
  })

  test('opens local workspaces from the titlebar IDE picker menu', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(true)
    render(
      <WorkspacePanelActions
        {...baseProps}
        currentProject={{
          id: 7,
          name: 'project38',
          config: {
            execution: {
              targetType: 'local',
              deviceId: 'device-1',
            },
            workspace: {
              source: 'local_path',
              localPath: '/Users/me/project38',
            },
          },
          tasks: [],
        }}
        devices={[
          {
            id: 1,
            device_id: 'device-1',
            name: 'Local Device',
            status: 'online',
            is_default: false,
            device_type: 'local',
            bind_shell: 'claudecode',
          },
        ]}
      />
    )

    await userEvent.click(screen.getByTestId('open-local-workspace-picker-button'))

    expect(screen.getByTestId('open-local-workspace-picker-menu')).toBeInTheDocument()
    expect(screen.getByTestId('open-local-workspace-option-android-studio')).toHaveTextContent(
      'Android Studio'
    )
    expect(screen.getByTestId('open-local-workspace-option-intellij-idea')).toHaveTextContent(
      'IntelliJ IDEA'
    )

    await userEvent.click(screen.getByTestId('open-local-workspace-option-intellij-idea'))

    await waitFor(() =>
      expect(openLocalWorkspaceMock).toHaveBeenCalledWith({
        opener: 'intellij-idea',
        path: '/Users/me/project38',
      })
    )
  })

  test('opens cloud IDE sessions through the external URL helper', async () => {
    render(
      <WorkspacePanelActions
        {...baseProps}
        currentProject={{
          id: 7,
          name: 'project38',
          config: {
            execution: {
              targetType: 'cloud',
              deviceId: 'device-1',
            },
          },
          tasks: [],
        }}
        devices={[
          {
            id: 1,
            device_id: 'device-1',
            name: 'Cloud Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'claudecode',
          },
        ]}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    await waitFor(() => expect(startCodeServerSessionMock).toHaveBeenCalledWith(7))
    expect(openExternalUrlMock).toHaveBeenCalledWith('http://localhost/ide')
  })
})
