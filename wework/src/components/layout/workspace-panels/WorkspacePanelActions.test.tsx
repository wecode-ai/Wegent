import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { openExternalUrl } from '@/lib/external-links'
import { isLocalTerminalAvailable, openLocalWorkspace } from '@/lib/local-terminal'
import { WorkspacePanelActions } from './WorkspacePanelActions'

vi.mock('@/lib/local-terminal', () => ({
  isLocalTerminalAvailable: vi.fn(),
  openLocalWorkspace: vi.fn(),
}))

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

const openExternalUrlMock = vi.mocked(openExternalUrl)
const isLocalTerminalAvailableMock = vi.mocked(isLocalTerminalAvailable)
const openLocalWorkspaceMock = vi.mocked(openLocalWorkspace)
const startProjectCodeServerMock = vi.fn()
const startDeviceCodeServerMock = vi.fn()
const workspaceSessionApi: WorkspaceSessionApi = {
  startProjectTerminal: vi.fn(),
  startProjectCodeServer: startProjectCodeServerMock,
  startDeviceTerminal: vi.fn(),
  startDeviceCodeServer: startDeviceCodeServerMock,
  createRemoteTerminalClient: vi.fn(),
}
const originalInnerWidth = window.innerWidth

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
}

const baseProps = {
  environmentInfo: {
    additions: '+0',
    deletions: '-0',
    executionTarget: 'local' as const,
  },
  environmentInfoPopoverContainer: document.body,
  environmentInfoVisible: true,
  environmentInfoOpen: false,
  onEnvironmentInfoOpenChange: vi.fn(),
  onRefreshEnvironmentInfo: vi.fn(),
  onCommitEnvironmentChanges: vi.fn(),
  onCommitAndPushEnvironmentChanges: vi.fn(),
  onPushEnvironmentChanges: vi.fn(),
  onListEnvironmentBranches: vi.fn(),
  onCheckoutEnvironmentBranch: vi.fn(),
  onCreateEnvironmentBranch: vi.fn(),
  onOpenEnvironmentChangesReview: vi.fn(),
  rightPanelOpen: false,
  bottomPanelOpen: false,
  onToggleRightPanel: vi.fn(),
  onToggleBottomPanel: vi.fn(),
  workspaceSessionApi,
}

describe('WorkspacePanelActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setWindowWidth(originalInnerWidth)
    isLocalTerminalAvailableMock.mockReturnValue(false)
    openLocalWorkspaceMock.mockResolvedValue(undefined)
    startProjectCodeServerMock.mockResolvedValue({
      session_id: 'ide-1',
      project_id: 7,
      device_id: 'device-1',
      type: 'code_server',
      url: 'http://localhost/ide',
      path: '/workspace/project',
    })
    startDeviceCodeServerMock.mockResolvedValue({
      session_id: 'ide-device-1',
      device_id: 'device-1',
      type: 'code_server',
      url: 'http://localhost/device-ide',
      path: '/workspace/project',
    })
    openExternalUrlMock.mockResolvedValue(true)
  })

  afterEach(() => {
    setWindowWidth(originalInnerWidth)
  })

  test('hides environment info while a task is being created', () => {
    render(<WorkspacePanelActions {...baseProps} environmentInfoVisible={false} />)

    expect(screen.queryByTestId('environment-info-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()
  })

  test('keeps environment info action visible after environment refresh resolves empty context', () => {
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

    expect(screen.getByTestId('environment-info-button')).toBeInTheDocument()

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

  test('hides environment info when no task context is available', () => {
    render(<WorkspacePanelActions {...baseProps} environmentInfoVisible={false} />)

    expect(screen.queryByTestId('environment-info-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()
  })

  test('keeps environment info collapsed by default in a conversation', () => {
    setWindowWidth(1280)

    render(<WorkspacePanelActions {...baseProps} mode="environment" />)

    expect(screen.getByTestId('environment-info-button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
  })

  test('reflects the shared pinned state in a project', () => {
    setWindowWidth(1280)

    render(
      <WorkspacePanelActions
        {...baseProps}
        mode="environment"
        environmentInfoOpen
        currentProject={{ id: 7, name: 'project38', config: {}, tasks: [] }}
      />
    )

    expect(screen.getByTestId('environment-info-button')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
  })

  test('opens environment info as a floating panel when the dock is collapsed', async () => {
    setWindowWidth(1024)
    function FloatingActions() {
      const [open, setOpen] = useState(false)
      return (
        <WorkspacePanelActions
          {...baseProps}
          mode="environment"
          environmentInfoDocked={false}
          environmentInfoOpen={open}
          onEnvironmentInfoOpenChange={setOpen}
        />
      )
    }
    render(<FloatingActions />)

    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('environment-info-button'))

    expect(screen.getByTestId('environment-info-popover')).toHaveClass('fixed', 'z-system')
  })

  test('renders environment info in its dedicated right-side container', async () => {
    setWindowWidth(1280)
    const workspaceContainer = document.createElement('main')
    document.body.append(workspaceContainer)

    try {
      function DockedActions() {
        const [open, setOpen] = useState(false)
        return (
          <WorkspacePanelActions
            {...baseProps}
            mode="environment"
            environmentInfoPopoverContainer={workspaceContainer}
            environmentInfoOpen={open}
            onEnvironmentInfoOpenChange={setOpen}
          />
        )
      }
      render(<DockedActions />)

      await userEvent.click(screen.getByTestId('environment-info-button'))

      const popover = screen.getByTestId('environment-info-popover')
      expect(workspaceContainer).toContainElement(popover)
      expect(popover).toHaveClass('w-[300px]')
      expect(popover).not.toHaveClass('absolute', 'fixed')
    } finally {
      workspaceContainer.remove()
    }
  })

  test('keeps environment info collapsed by default when the dock is unavailable', () => {
    render(
      <WorkspacePanelActions {...baseProps} mode="environment" environmentInfoDocked={false} />
    )

    expect(screen.getByTestId('environment-info-button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
  })

  test('uses the supplied overlay state when the dock becomes unavailable', () => {
    const { rerender } = render(
      <WorkspacePanelActions {...baseProps} mode="environment" environmentInfoOpen />
    )

    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()

    rerender(
      <WorkspacePanelActions
        {...baseProps}
        mode="environment"
        environmentInfoDocked={false}
        environmentInfoOpen={false}
      />
    )

    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
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

    expect(screen.getByTestId('local-workspace-titlebar-control')).toHaveClass(
      'h-8',
      'overflow-hidden',
      'rounded-[14px]',
      'border-border/60',
      'bg-background'
    )
    expect(screen.getByTestId('open-code-server-titlebar-button')).toHaveClass(
      'h-8',
      'gap-1.5',
      'bg-transparent',
      'hover:bg-black/[0.06]',
      'active:bg-black/[0.10]'
    )
    expect(screen.getByTestId('open-code-server-titlebar-button')).toHaveTextContent(
      /Open location|打开位置|workbench\.open_workspace_location/
    )
    expect(screen.getByTestId('open-local-workspace-picker-button')).toHaveClass(
      'h-8',
      'w-7',
      'hover:bg-black/[0.06]'
    )
    expect(screen.getByTestId('open-local-workspace-picker-button')).not.toHaveClass('border-l')

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    expect(openLocalWorkspaceMock).toHaveBeenCalledWith({
      opener: 'vscode',
      path: '/Users/me/project38',
    })
    expect(startProjectCodeServerMock).not.toHaveBeenCalled()
    expect(startDeviceCodeServerMock).not.toHaveBeenCalled()
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

    await waitFor(() => expect(startProjectCodeServerMock).toHaveBeenCalledWith(7))
    expect(openExternalUrlMock).toHaveBeenCalledWith('http://localhost/ide', {
      target: 'system',
    })
  })

  test('reports a missing cloud IDE URL from the titlebar action', async () => {
    startProjectCodeServerMock.mockResolvedValueOnce({
      session_id: 'ide-1',
      project_id: 7,
      device_id: 'device-1',
      type: 'code_server',
      url: '',
      path: '/workspace/project',
    })
    render(
      <WorkspacePanelActions
        {...baseProps}
        currentProject={{
          id: 7,
          name: 'project38',
          config: { execution: { targetType: 'cloud', deviceId: 'device-1' } },
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

    expect(await screen.findByTestId('code-server-error-dialog')).toHaveTextContent(
      'IDE session URL is missing'
    )
    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })

  test('opens remote runtime workspaces through the device IDE session and exact path', async () => {
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
          },
          tasks: [],
        }}
        workspaceTarget={{
          deviceId: 'device-2',
          path: '/workspace/worktrees/9/project38',
          source: 'runtime',
          workspaceSource: 'remote',
        }}
        devices={[
          {
            id: 2,
            device_id: 'device-2',
            name: 'Remote Device',
            status: 'online',
            is_default: false,
            device_type: 'remote',
            bind_shell: 'claudecode',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('local-workspace-titlebar-control')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    await waitFor(() =>
      expect(startDeviceCodeServerMock).toHaveBeenCalledWith(
        'device-2',
        '/workspace/worktrees/9/project38'
      )
    )
    expect(startProjectCodeServerMock).not.toHaveBeenCalled()
    expect(openLocalWorkspaceMock).not.toHaveBeenCalled()
    expect(openExternalUrlMock).toHaveBeenCalledWith('http://localhost/device-ide', {
      target: 'system',
    })
  })

  test('opens routed remote workspaces from the titlebar location action', async () => {
    render(
      <WorkspacePanelActions
        {...baseProps}
        currentProject={{ id: 7, name: 'project38', config: {}, tasks: [] }}
        workspaceTarget={{
          deviceId: 'cloud-device',
          path: '/home/ubuntu/project38',
          source: 'runtime',
          workspaceSource: 'remote',
        }}
        devices={[
          {
            id: 31,
            device_id: 'local-device',
            name: 'Local Executor',
            status: 'online',
            is_default: true,
            device_type: 'local',
            bind_shell: 'claudecode',
            runtime_routes: [
              {
                kind: 'cloud-relay',
                device_id: 'cloud-device',
                runtime_device_id: 'cloud-device',
                device_type: 'cloud',
                status: 'online',
              },
            ],
          },
        ]}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    await waitFor(() =>
      expect(startDeviceCodeServerMock).toHaveBeenCalledWith(
        'cloud-device',
        '/home/ubuntu/project38'
      )
    )
    expect(openExternalUrlMock).toHaveBeenCalledWith('http://localhost/device-ide', {
      target: 'system',
    })
  })
})
