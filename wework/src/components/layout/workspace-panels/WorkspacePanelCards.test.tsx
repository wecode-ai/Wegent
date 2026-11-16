import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  isLocalTerminalAvailable,
  localPathExists,
  startLocalTerminal,
} from '@/lib/local-terminal'
import type { DeviceInfo } from '@/types/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Monitor } from 'lucide-react'
import { useCallback, useEffect, type ComponentProps } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspacePanelCards as ActualWorkspacePanelCards } from './WorkspacePanelCards'

const deviceSurfaceExtensionMock = vi.hoisted(() => {
  const launch = vi.fn()

  return {
    available: true,
    DeviceAction: vi.fn(),
    workspaceMenuItem: vi.fn(() => ({
      id: 'device-surface',
      label: '设备界面',
      icon: Monitor,
      testId: 'workspace-add-device-surface-option',
    })),
    supportsDevice: vi.fn(
      (device: {
        bind_shell?: string
        device_type: string
        runtime_routes?: Array<{ kind: string }>
      }) =>
        (device.bind_shell ?? 'claudecode').toLowerCase() === 'claudecode' &&
        (device.device_type === 'cloud' ||
          Boolean(device.runtime_routes?.some(route => route.kind === 'cloud-relay')))
    ),
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
        const launchAction = useCallback(
          async (options?: { notifyOpened?: boolean }) => {
            onErrorChange(null)
            onBusyChange(true)
            try {
              const opened = await launch(options)
              if (opened && options?.notifyOpened !== false) onOpened()
            } finally {
              onBusyChange(false)
            }
          },
          [onBusyChange, onErrorChange, onOpened]
        )
        useEffect(() => {
          onLaunchActionChange?.(launchAction)
          return () => onLaunchActionChange?.(null)
        }, [launchAction, onLaunchActionChange])

        return (
          <button
            type="button"
            data-testid="workspace-device-surface-card"
            disabled={disabled}
            onClick={() => void launchAction()}
          >
            设备界面
          </button>
        )
      }
    ),
    isInternalPageUrl: vi.fn(() => false),
    launch,
  }
})

vi.mock('@extensions/device-surface', () => ({
  deviceSurfaceExtension: deviceSurfaceExtensionMock,
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
    runtime_features: {
      schemaVersion: 4,
    },
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
    deviceSurfaceExtensionMock.available = true
    deviceSurfaceExtensionMock.launch.mockResolvedValue(true)
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

  test('launches the native terminal for local project devices without cloud-only tools', async () => {
    render(<WorkspacePanelCards currentProject={project} devices={localDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/workspace/projects/project38',
        })
      )
    )
    expect(getLocalExecutorDeviceIdMock).toHaveBeenCalledWith('/api')
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-terminal-1'
    )
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-device-surface-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('launches the native terminal for local projects without requiring a device list match', async () => {
    getLocalExecutorDeviceIdMock.mockResolvedValue(null)

    render(<WorkspacePanelCards currentProject={project} devices={[]} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/workspace/projects/project38',
        })
      )
    )
    expect(localPathExistsMock).toHaveBeenCalledWith('/workspace/projects/project38')
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-terminal-1'
    )
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('closes local terminal sessions when the workspace panel unmounts', async () => {
    const { unmount } = render(<WorkspacePanelCards currentProject={project} devices={[]} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))
    await waitFor(() => expect(startLocalTerminalMock).toHaveBeenCalled())

    unmount()

    expect(closeLocalTerminalMock).toHaveBeenCalledWith('local-terminal-1', {
      reason: 'workspace-panel-unmount',
      taskId: undefined,
      workspacePath: '/workspace/projects/project38',
    })
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
      expect(startLocalTerminalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/workspace/projects/project38',
        })
      )
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
      expect(startLocalTerminalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/workspace/worktrees/8/project38',
        })
      )
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
      expect(startLocalTerminalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/workspace/runtime/project38',
        })
      )
    )
    expect(startProjectTerminalMock).not.toHaveBeenCalled()
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

  test('launches the native terminal when the executor id differs but the local path exists', async () => {
    getLocalExecutorDeviceIdMock.mockResolvedValue('another-device')

    render(<WorkspacePanelCards currentProject={project} devices={localDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/workspace/projects/project38',
        })
      )
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

  test('marks terminal as unavailable when session probing fails', async () => {
    startProjectTerminalMock.mockRejectedValueOnce(new Error('terminal unavailable'))
    render(<WorkspacePanelCards currentProject={cloudProject} devices={cloudDevices} />)

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    await waitFor(() => expect(screen.getByTestId('workspace-terminal-card')).toBeDisabled())
    expect(screen.getByTestId('workspace-terminal-card')).toHaveTextContent('暂不可用')

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    expect(startProjectTerminalMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('workspace-device-surface-card')).not.toBeDisabled()
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
