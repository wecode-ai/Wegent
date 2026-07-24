import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  isLocalTerminalAvailable,
  localPathExists,
  startLocalTerminal,
} from '@/lib/local-terminal'
import { WorkspacePanelCards as ActualWorkspacePanelCards } from './WorkspacePanelCards'
import type { DeviceInfo } from '@/types/api'

const cloudDesktopExtensionMock = vi.hoisted(() => {
  const launch = vi.fn()

  return {
    available: true,
    DeviceAction: vi.fn(),
    WorkspaceAction: vi.fn(
      ({
        disabled,
        onBusyChange,
        onErrorChange,
        onLaunchActionChange,
        onOpened,
      }: {
        disabled: boolean
        onBusyChange: (busy: boolean) => void
        onErrorChange: (message: string | null) => void
        onLaunchActionChange?: (
          action: ((options?: { notifyOpened?: boolean }) => Promise<void>) | null
        ) => void
        onOpened: () => void
      }) => {
        const launchAction = async (options?: { notifyOpened?: boolean }) => {
          onErrorChange(null)
          onBusyChange(true)
          try {
            const opened = await launch(options)
            if (opened && options?.notifyOpened !== false) onOpened()
          } finally {
            onBusyChange(false)
          }
        }
        onLaunchActionChange?.(launchAction)

        return (
          <button
            type="button"
            data-testid="workspace-desktop-card"
            disabled={disabled}
            onClick={() => void launchAction()}
          >
            桌面
          </button>
        )
      }
    ),
    isInternalPageUrl: vi.fn(() => false),
    launch,
  }
})

vi.mock('@extensions/cloud-desktop', () => ({
  cloudDesktopExtension: cloudDesktopExtensionMock,
}))

const runtimeConfigMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({ appBasePath: '', apiBaseUrl: '/api' })),
}))

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: runtimeConfigMocks.getRuntimeConfig,
  joinAppPath: (basePath: string, path: string) => {
    const normalizedBasePath = !basePath || basePath === '/' ? '' : basePath.replace(/\/+$/, '')
    const normalizedPath = path.startsWith('/') ? path : `/${path}`

    if (!normalizedBasePath) return normalizedPath
    if (normalizedPath === '/') return `${normalizedBasePath}/`
    return `${normalizedBasePath}${normalizedPath}`
  },
}))

vi.mock('@/lib/local-terminal', () => ({
  closeLocalTerminal: vi.fn(),
  getLocalExecutorDeviceId: vi.fn(),
  isLocalTerminalAvailable: vi.fn(),
  localPathExists: vi.fn(),
  startLocalTerminal: vi.fn(),
}))

vi.mock('./EmbeddedLocalTerminal', () => ({
  EmbeddedLocalTerminal: ({
    active,
    sessionId,
    onExit,
  }: {
    active: boolean
    sessionId: string
    onExit?: () => void
  }) => (
    <div data-testid="embedded-local-terminal" data-session-id={sessionId} hidden={!active}>
      <button
        type="button"
        data-testid={`embedded-local-terminal-exit-${sessionId}`}
        onClick={onExit}
      />
    </div>
  ),
}))

const remoteTerminalMocks = vi.hoisted(() => ({
  render: vi.fn(),
}))

vi.mock('./RemoteTerminal', () => ({
  RemoteTerminal: ({
    active,
    sessionId,
    clientFactory,
    onExit,
  }: {
    active: boolean
    sessionId: string
    clientFactory: WorkspaceSessionApi['createRemoteTerminalClient']
    onExit?: () => void
  }) => {
    remoteTerminalMocks.render({ active, sessionId, clientFactory })
    return (
      <div
        data-testid="remote-terminal"
        data-session-id={sessionId}
        className="h-full w-full"
        hidden={!active}
      >
        <button type="button" data-testid={`remote-terminal-exit-${sessionId}`} onClick={onExit} />
      </div>
    )
  },
}))

const closeLocalTerminalMock = vi.mocked(closeLocalTerminal)
const getLocalExecutorDeviceIdMock = vi.mocked(getLocalExecutorDeviceId)
const isLocalTerminalAvailableMock = vi.mocked(isLocalTerminalAvailable)
const localPathExistsMock = vi.mocked(localPathExists)
const startLocalTerminalMock = vi.mocked(startLocalTerminal)
const startProjectTerminalMock = vi.fn()
const startDeviceTerminalMock = vi.fn()
const createRemoteTerminalClientMock = vi.fn()
const workspaceSessionApi: WorkspaceSessionApi = {
  startProjectTerminal: startProjectTerminalMock,
  startProjectCodeServer: vi.fn(),
  startDeviceTerminal: startDeviceTerminalMock,
  startDeviceCodeServer: vi.fn(),
  createRemoteTerminalClient: createRemoteTerminalClientMock,
}

function WorkspacePanelCards(props: ComponentProps<typeof ActualWorkspacePanelCards>) {
  return <ActualWorkspacePanelCards workspaceSessionApi={workspaceSessionApi} {...props} />
}

const project = {
  id: 7,
  name: 'project38',
  config: {
    execution: {
      targetType: 'local' as const,
      deviceId: 'device-1',
    },
    workspace: {
      source: 'local_path' as const,
      localPath: '/workspace/projects/project38',
    },
  },
  tasks: [],
}

const cloudProject = {
  ...project,
  config: {
    ...project.config,
    execution: {
      targetType: 'cloud' as const,
      deviceId: 'device-1',
    },
    workspace: {
      source: 'git' as const,
      checkoutPath: '/workspace/projects/project38',
    },
  },
}

const cloudDevices: DeviceInfo[] = [
  {
    id: 1,
    device_id: 'device-1',
    name: 'Cloud Device',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
  },
]

const localDevices: DeviceInfo[] = [
  {
    id: 2,
    device_id: 'device-1',
    name: 'Local Device',
    status: 'online',
    is_default: false,
    device_type: 'local',
    bind_shell: 'claudecode',
  },
]

const openClawCloudDevices: DeviceInfo[] = [
  {
    id: 3,
    device_id: 'device-1',
    name: 'OpenClaw Device',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'openclaw',
  },
]

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe('WorkspacePanelCards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'open').mockImplementation(() => null)
    window.localStorage.setItem('auth_token', 'token-1')
    cloudDesktopExtensionMock.available = true
    cloudDesktopExtensionMock.launch.mockResolvedValue(true)
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue('device-1')
    localPathExistsMock.mockResolvedValue(true)
    startLocalTerminalMock.mockResolvedValue('local-terminal-1')
    closeLocalTerminalMock.mockResolvedValue(undefined)
    let terminalSessionCount = 0
    startProjectTerminalMock.mockImplementation(async () => {
      terminalSessionCount += 1
      return {
        session_id: `terminal-${terminalSessionCount}`,
        project_id: 7,
        url: '',
        transport: 'socketio',
        device_id: 'device-1',
        type: 'terminal',
        path: '/workspace/projects/project38',
      }
    })
    startDeviceTerminalMock.mockResolvedValue({
      session_id: 'device-terminal-1',
      url: '',
      transport: 'socketio',
      device_id: 'device-2',
      type: 'terminal',
      path: '/workspace/worktrees/9/project38',
    })
  })

  test('renders terminal and desktop project tools', () => {
    render(<WorkspacePanelCards currentProject={cloudProject} devices={cloudDevices} />)

    expect(screen.getByTestId('workspace-terminal-card')).toHaveTextContent('终端')
    expect(screen.getByTestId('workspace-desktop-card')).toHaveTextContent('桌面')
  })

  test('embeds the project terminal through the backend Socket.IO relay', async () => {
    render(<WorkspacePanelCards currentProject={cloudProject} devices={cloudDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() => expect(startProjectTerminalMock).toHaveBeenCalledWith(7))
    expect(remoteTerminalMocks.render).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'terminal-1',
        clientFactory: createRemoteTerminalClientMock,
      })
    )
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.queryByTestId('workspace-terminal-frame')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-window')).toHaveClass('bg-background')
    expect(screen.getByTestId('workspace-terminal-tab')).toHaveTextContent('project38')
    expect(screen.getByTestId('workspace-terminal-new-tab-button')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-close-button')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/projects/project38')).not.toBeInTheDocument()
  })

  test('opens a device root terminal without a selected project', async () => {
    render(
      <WorkspacePanelCards
        currentProject={null}
        devices={cloudDevices}
        workspaceTarget={{ deviceId: 'device-1', path: '/', source: 'runtime' }}
      />
    )

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() => expect(startDeviceTerminalMock).toHaveBeenCalledWith('device-1', '/'))
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute(
      'data-session-id',
      'device-terminal-1'
    )
  })

  test('gives the embedded terminal explicit dimensions for Safari', async () => {
    render(<WorkspacePanelCards currentProject={cloudProject} devices={cloudDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() => expect(screen.getByTestId('remote-terminal')).toBeInTheDocument())
    expect(screen.getByTestId('remote-terminal')).toHaveClass('h-full', 'w-full')
  })

  test('opens the terminal add menu from the terminal plus button', async () => {
    render(<WorkspacePanelCards currentProject={cloudProject} devices={cloudDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))
    await waitFor(() => expect(screen.getByTestId('remote-terminal')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))

    expect(screen.getByTestId('workspace-terminal-window')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.queryByTestId('workspace-tool-launcher')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-terminal-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-new-tab-menu')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-add-terminal-option')).toHaveTextContent('终端')
    expect(startProjectTerminalMock).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('workspace-add-terminal-option'))

    await waitFor(() => expect(startProjectTerminalMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('workspace-terminal-new-tab-menu')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('workspace-terminal-tab')).toHaveLength(2)
    expect(screen.getAllByTestId('workspace-terminal-close-button')).toHaveLength(2)
    const terminals = screen.getAllByTestId('remote-terminal')
    expect(terminals).toHaveLength(2)
    expect(terminals[0]).toHaveAttribute('data-session-id', 'terminal-1')
    expect(terminals[0]).toHaveAttribute('hidden')
    expect(terminals[1]).toHaveAttribute('data-session-id', 'terminal-2')
    expect(terminals[1]).not.toHaveAttribute('hidden')

    await userEvent.click(screen.getAllByTestId('workspace-terminal-close-button')[1])

    expect(screen.getAllByTestId('workspace-terminal-tab')).toHaveLength(1)
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.getByTestId('remote-terminal')).not.toHaveAttribute('hidden')
  })

  test('removes the terminal session when the process exits', async () => {
    render(<WorkspacePanelCards currentProject={cloudProject} devices={cloudDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))
    await waitFor(() => expect(screen.getByTestId('remote-terminal')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('remote-terminal-exit-terminal-1'))

    expect(screen.queryByTestId('remote-terminal')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-tool-launcher')).toBeInTheDocument()
  })

  test('opens the project desktop through the cloud extension', async () => {
    const onRequestClose = vi.fn()
    render(
      <WorkspacePanelCards
        currentProject={cloudProject}
        devices={cloudDevices}
        onRequestClose={onRequestClose}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-desktop-card'))

    await waitFor(() => expect(cloudDesktopExtensionMock.launch).toHaveBeenCalledWith(undefined))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  test('publishes menu actions that keep the current terminal and panel open', async () => {
    const onRequestClose = vi.fn()
    const onMenuActionsChange = vi.fn()
    render(
      <WorkspacePanelCards
        currentProject={cloudProject}
        devices={cloudDevices}
        onRequestClose={onRequestClose}
        onMenuActionsChange={onMenuActionsChange}
      />
    )

    await waitFor(() => expect(onMenuActionsChange).toHaveBeenCalled())
    const actions = onMenuActionsChange.mock.lastCall?.[0]
    expect(actions).toMatchObject({
      terminal: { visible: true, disabled: false },
      desktop: { visible: true, disabled: false },
    })

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))
    await waitFor(() => expect(screen.getByTestId('remote-terminal')).toBeInTheDocument())

    await act(async () => actions.desktop.run())

    expect(cloudDesktopExtensionMock.launch).toHaveBeenCalledWith({ notifyOpened: false })
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  test('hides the desktop card when the cloud desktop extension is unavailable', () => {
    cloudDesktopExtensionMock.available = false

    render(<WorkspacePanelCards currentProject={cloudProject} devices={cloudDevices} />)

    expect(screen.queryByTestId('workspace-desktop-card')).not.toBeInTheDocument()
  })

  test('disables the desktop card while its cloud device is offline', () => {
    render(
      <WorkspacePanelCards
        currentProject={cloudProject}
        devices={cloudDevices.map(device => ({ ...device, status: 'offline' }))}
      />
    )

    expect(screen.getByTestId('workspace-desktop-card')).toBeDisabled()
  })

  test('launches the native terminal for local project devices without cloud-only tools', async () => {
    render(<WorkspacePanelCards currentProject={project} devices={localDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/workspace/projects/project38',
      })
    )
    expect(getLocalExecutorDeviceIdMock).toHaveBeenCalledWith('/api')
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-terminal-1'
    )
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-desktop-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('launches the native terminal for local projects without requiring a device list match', async () => {
    getLocalExecutorDeviceIdMock.mockResolvedValue(null)

    render(<WorkspacePanelCards currentProject={project} devices={[]} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/workspace/projects/project38',
      })
    )
    expect(localPathExistsMock).toHaveBeenCalledWith('/workspace/projects/project38')
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-terminal-1'
    )
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('launches a preferred local terminal from a git checkout path', async () => {
    getLocalExecutorDeviceIdMock.mockResolvedValue(null)

    render(<WorkspacePanelCards currentProject={cloudProject} devices={[]} preferLocalTerminal />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/workspace/projects/project38',
      })
    )
    expect(localPathExistsMock).toHaveBeenCalledWith('/workspace/projects/project38')
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('closes local terminal sessions when the workspace panel unmounts', async () => {
    const { unmount } = render(<WorkspacePanelCards currentProject={project} devices={[]} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))
    await waitFor(() => expect(startLocalTerminalMock).toHaveBeenCalled())

    unmount()

    expect(closeLocalTerminalMock).toHaveBeenCalledWith('local-terminal-1')
  })

  test('closes local terminal sessions when the workspace target changes', async () => {
    const nextProject = {
      ...project,
      id: 8,
      name: 'project39',
      config: {
        ...project.config,
        workspace: {
          ...project.config.workspace,
          localPath: '/workspace/projects/project39',
        },
      },
    }
    const { rerender } = render(<WorkspacePanelCards currentProject={project} devices={[]} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))
    await waitFor(() => expect(startLocalTerminalMock).toHaveBeenCalled())

    rerender(<WorkspacePanelCards currentProject={nextProject} devices={[]} />)

    expect(closeLocalTerminalMock).toHaveBeenCalledWith('local-terminal-1')
    expect(screen.queryByTestId('embedded-local-terminal')).not.toBeInTheDocument()
  })

  test('waits for the local terminal check before default-opening local project terminals', async () => {
    const pathCheck = createDeferred<boolean>()
    getLocalExecutorDeviceIdMock.mockResolvedValue('another-device')
    localPathExistsMock.mockReturnValue(pathCheck.promise)

    render(
      <WorkspacePanelCards
        currentProject={project}
        devices={localDevices}
        defaultOpenTool="terminal"
      />
    )

    await waitFor(() =>
      expect(localPathExistsMock).toHaveBeenCalledWith('/workspace/projects/project38')
    )
    expect(startLocalTerminalMock).not.toHaveBeenCalled()
    expect(startProjectTerminalMock).not.toHaveBeenCalled()

    pathCheck.resolve(true)

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/workspace/projects/project38',
      })
    )
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
  })

  test('launches the native terminal in the active workspace target path', async () => {
    render(
      <WorkspacePanelCards
        currentProject={project}
        devices={localDevices}
        workspaceTarget={{
          deviceId: 'device-1',
          path: '/workspace/worktrees/8/project38',
          source: 'runtime',
        }}
      />
    )

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/workspace/worktrees/8/project38',
      })
    )
    expect(localPathExistsMock).toHaveBeenCalledWith('/workspace/worktrees/8/project38')
  })

  test('launches the native terminal for a runtime workspace without requiring a project', async () => {
    render(
      <WorkspacePanelCards
        currentProject={null}
        devices={localDevices}
        workspaceTarget={{
          deviceId: 'device-1',
          path: '/workspace/runtime/project38',
          source: 'runtime',
        }}
      />
    )

    expect(screen.queryByText('请选择项目后使用')).not.toBeInTheDocument()

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/workspace/runtime/project38',
      })
    )
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
  })

  test('does not fall back to the backend remote terminal outside the WeWork macOS app', () => {
    isLocalTerminalAvailableMock.mockReturnValue(false)

    render(<WorkspacePanelCards currentProject={project} devices={localDevices} />)

    expect(screen.queryByTestId('workspace-terminal-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-local-device-limited-tools')).toBeInTheDocument()
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
    expect(startLocalTerminalMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-ide-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-desktop-card')).not.toBeInTheDocument()
  })

  test('starts remote terminal on the active runtime workspace device and path', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(false)

    render(
      <WorkspacePanelCards
        currentProject={project}
        devices={[
          ...localDevices,
          {
            id: 22,
            device_id: 'device-2',
            name: 'Remote Device',
            status: 'online',
            is_default: false,
            device_type: 'remote',
            bind_shell: 'claudecode',
          },
        ]}
        workspaceTarget={{
          deviceId: 'device-2',
          path: '/workspace/worktrees/9/project38',
          source: 'runtime',
        }}
      />
    )

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startDeviceTerminalMock).toHaveBeenCalledWith(
        'device-2',
        '/workspace/worktrees/9/project38'
      )
    )
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
  })

  test('starts remote terminal on a new project workspace device and path', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(false)

    render(
      <WorkspacePanelCards
        currentProject={cloudProject}
        devices={cloudDevices}
        workspaceTarget={{
          deviceId: 'device-1',
          path: '/workspace/projects/project38',
          source: 'project',
          workspaceSource: 'remote',
        }}
      />
    )

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startDeviceTerminalMock).toHaveBeenCalledWith(
        'device-1',
        '/workspace/projects/project38'
      )
    )
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
  })

  test('uses the cloud route for a remote workspace merged into the local device', async () => {
    getLocalExecutorDeviceIdMock.mockResolvedValue('local-device')
    localPathExistsMock.mockResolvedValue(false)

    render(
      <WorkspacePanelCards
        currentProject={cloudProject}
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
                kind: 'local-ipc',
                device_id: 'local-device',
                runtime_device_id: 'local-device',
                device_type: 'local',
                status: 'online',
              },
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
        workspaceTarget={{
          deviceId: 'cloud-device',
          path: '/home/ubuntu/project38',
          source: 'project',
          workspaceSource: 'remote',
        }}
      />
    )

    expect(await screen.findByTestId('workspace-desktop-card')).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startDeviceTerminalMock).toHaveBeenCalledWith('cloud-device', '/home/ubuntu/project38')
    )
    expect(startLocalTerminalMock).not.toHaveBeenCalled()
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
  })

  test('launches the native terminal when the executor id differs but the local path exists', async () => {
    getLocalExecutorDeviceIdMock.mockResolvedValue('another-device')

    render(<WorkspacePanelCards currentProject={project} devices={localDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/workspace/projects/project38',
      })
    )
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-terminal-1'
    )
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('does not fall back to the backend remote terminal when the local path cannot be opened', async () => {
    getLocalExecutorDeviceIdMock.mockResolvedValue('another-device')
    localPathExistsMock.mockResolvedValue(false)

    render(<WorkspacePanelCards currentProject={project} devices={localDevices} />)

    await waitFor(() => expect(localPathExistsMock).toHaveBeenCalled())
    expect(screen.getByTestId('workspace-terminal-card')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('启动失败'))
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
    expect(startLocalTerminalMock).not.toHaveBeenCalled()
  })

  test('does not show ClaudeCode-only project tools for OpenClaw devices', () => {
    render(<WorkspacePanelCards currentProject={cloudProject} devices={openClawCloudDevices} />)

    expect(screen.queryByTestId('workspace-terminal-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-desktop-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-local-device-limited-tools')).toBeInTheDocument()
  })

  test('shows local terminal before the local project device list is loaded', () => {
    render(<WorkspacePanelCards currentProject={project} devices={[]} />)

    expect(screen.getByTestId('workspace-terminal-card')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-desktop-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('marks terminal as unavailable when session probing fails', async () => {
    startProjectTerminalMock.mockRejectedValueOnce(new Error('terminal unavailable'))
    render(<WorkspacePanelCards currentProject={cloudProject} devices={cloudDevices} />)

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    await waitFor(() => expect(screen.getByTestId('workspace-terminal-card')).toBeDisabled())
    expect(screen.getByTestId('workspace-terminal-card')).toHaveTextContent('暂不可用')

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    expect(startProjectTerminalMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('workspace-desktop-card')).not.toBeDisabled()
  })

  test('resets unavailable tools when the project changes', async () => {
    startProjectTerminalMock.mockRejectedValueOnce(new Error('terminal unavailable'))
    const nextProject = {
      ...cloudProject,
      id: 8,
      name: 'project39',
    }
    const { rerender } = render(
      <WorkspacePanelCards currentProject={cloudProject} devices={cloudDevices} />
    )

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    await waitFor(() => expect(screen.getByTestId('workspace-terminal-card')).toBeDisabled())

    rerender(<WorkspacePanelCards currentProject={nextProject} devices={cloudDevices} />)

    expect(screen.getByTestId('workspace-terminal-card')).not.toBeDisabled()
    expect(screen.getByTestId('workspace-terminal-card')).not.toHaveTextContent('暂不可用')
  })
})
