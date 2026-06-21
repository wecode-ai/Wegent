import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createDeviceApi } from '@/api/devices'
import { createProjectApi } from '@/api/projects'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  isLocalTerminalAvailable,
  localPathExists,
  startLocalTerminal,
} from '@/lib/local-terminal'
import { WorkspacePanelCards } from './WorkspacePanelCards'
import type { DeviceInfo } from '@/types/api'

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({ appBasePath: '', apiBaseUrl: '/api' }),
  joinAppPath: (basePath: string, path: string) => {
    const normalizedBasePath = !basePath || basePath === '/' ? '' : basePath.replace(/\/+$/, '')
    const normalizedPath = path.startsWith('/') ? path : `/${path}`

    if (!normalizedBasePath) return normalizedPath
    if (normalizedPath === '/') return `${normalizedBasePath}/`
    return `${normalizedBasePath}${normalizedPath}`
  },
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(() => ({})),
}))

vi.mock('@/api/projects', () => ({
  createProjectApi: vi.fn(),
}))

vi.mock('@/api/devices', () => ({
  createDeviceApi: vi.fn(),
}))

vi.mock('@/lib/local-terminal', () => ({
  closeLocalTerminal: vi.fn(),
  getLocalExecutorDeviceId: vi.fn(),
  isLocalTerminalAvailable: vi.fn(),
  localPathExists: vi.fn(),
  startLocalTerminal: vi.fn(),
}))

vi.mock('./EmbeddedLocalTerminal', () => ({
  EmbeddedLocalTerminal: ({ active, sessionId }: { active: boolean; sessionId: string }) => (
    <div data-testid="embedded-local-terminal" data-session-id={sessionId} hidden={!active} />
  ),
}))

vi.mock('./RemoteTerminal', () => ({
  RemoteTerminal: ({ active, sessionId }: { active: boolean; sessionId: string }) => (
    <div
      data-testid="remote-terminal"
      data-session-id={sessionId}
      className="h-full w-full"
      hidden={!active}
    />
  ),
}))

const createDeviceApiMock = vi.mocked(createDeviceApi)
const createProjectApiMock = vi.mocked(createProjectApi)
const closeLocalTerminalMock = vi.mocked(closeLocalTerminal)
const getLocalExecutorDeviceIdMock = vi.mocked(getLocalExecutorDeviceId)
const isLocalTerminalAvailableMock = vi.mocked(isLocalTerminalAvailable)
const localPathExistsMock = vi.mocked(localPathExists)
const startLocalTerminalMock = vi.mocked(startLocalTerminal)
const getVncConfigMock = vi.fn()
const fetchMock = vi.fn()

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

describe('WorkspacePanelCards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    vi.spyOn(window, 'open').mockImplementation(() => null)
    window.localStorage.setItem('auth_token', 'token-1')
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue('device-1')
    localPathExistsMock.mockResolvedValue(true)
    startLocalTerminalMock.mockResolvedValue('local-terminal-1')
    closeLocalTerminalMock.mockResolvedValue(undefined)
    let terminalSessionCount = 0
    createProjectApiMock.mockReturnValue({
      startTerminalSession: vi.fn().mockImplementation(async () => {
        terminalSessionCount += 1
        return {
          session_id: `terminal-${terminalSessionCount}`,
          url: '',
          transport: 'socketio',
          device_id: 'device-1',
          path: '/workspace/projects/project38',
        }
      }),
      startCodeServerSession: vi.fn().mockResolvedValue({
        url: 'http://localhost/ide',
        path: '/workspace/projects/project38',
      }),
    } as unknown as ReturnType<typeof createProjectApi>)
    createDeviceApiMock.mockReturnValue({
      getVncConfig: getVncConfigMock,
      startTerminal: vi.fn().mockResolvedValue({
        session_id: 'device-terminal-1',
        url: '',
        transport: 'socketio',
        device_id: 'device-2',
        type: 'terminal',
        path: '/workspace/worktrees/9/project38',
      }),
    } as unknown as ReturnType<typeof createDeviceApi>)
    getVncConfigMock.mockResolvedValue({
      wss_url: 'wss://example.com/vnc',
      signature: 'signature',
      sandbox_id: 'sandbox-1',
    })
  })

  test('renders terminal, IDE, and desktop project tools', () => {
    render(<WorkspacePanelCards currentProject={project} devices={cloudDevices} />)

    expect(screen.queryByTestId('workspace-browser-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-card')).toHaveTextContent('终端')
    expect(screen.getByTestId('workspace-ide-card')).toHaveTextContent('IDE')
    expect(screen.getByTestId('workspace-desktop-card')).toHaveTextContent('桌面')
  })

  test('embeds the project terminal through the backend Socket.IO relay', async () => {
    const api = createProjectApiMock()
    render(<WorkspacePanelCards currentProject={project} devices={cloudDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() => expect(api.startTerminalSession).toHaveBeenCalledWith(7))
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.queryByTestId('workspace-terminal-frame')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-window')).toHaveClass('bg-white')
    expect(screen.getByTestId('workspace-terminal-tab')).toHaveTextContent('project38')
    expect(screen.getByTestId('workspace-terminal-new-tab-button')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-close-button')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/projects/project38')).not.toBeInTheDocument()
  })

  test('starts cloud project sessions scoped to the active task workspace', async () => {
    const api = createProjectApiMock()
    render(
      <WorkspacePanelCards
        currentProject={project}
        devices={cloudDevices}
        workspaceTarget={{
          deviceId: 'device-1',
          path: '/workspace/worktrees/8/project38',
          source: 'task',
          taskId: 8,
        }}
      />
    )

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() => expect(api.startTerminalSession).toHaveBeenCalledWith(7, { taskId: 8 }))
  })

  test('starts cloud IDE sessions scoped to the active task workspace', async () => {
    const api = createProjectApiMock()
    render(
      <WorkspacePanelCards
        currentProject={project}
        devices={cloudDevices}
        workspaceTarget={{
          deviceId: 'device-1',
          path: '/workspace/worktrees/8/project38',
          source: 'task',
          taskId: 8,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-ide-card'))

    await waitFor(() => expect(api.startCodeServerSession).toHaveBeenCalledWith(7, { taskId: 8 }))
  })

  test('gives the embedded terminal explicit dimensions for Safari', async () => {
    render(<WorkspacePanelCards currentProject={project} devices={cloudDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() => expect(screen.getByTestId('remote-terminal')).toBeInTheDocument())
    expect(screen.getByTestId('remote-terminal')).toHaveClass('h-full', 'w-full')
  })

  test('shows project tool cards from the terminal plus button', async () => {
    const api = createProjectApiMock()
    render(<WorkspacePanelCards currentProject={project} devices={cloudDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))
    await waitFor(() => expect(screen.getByTestId('remote-terminal')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))

    expect(screen.getByTestId('workspace-terminal-window')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.getByTestId('workspace-tool-launcher')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-card')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-ide-card')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-desktop-card')).toBeInTheDocument()
    expect(api.startTerminalSession).toHaveBeenCalledTimes(1)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() => expect(api.startTerminalSession).toHaveBeenCalledTimes(2))
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

  test('opens the project IDE in a new page without a preflight probe', async () => {
    const api = createProjectApiMock()
    const onRequestClose = vi.fn()
    render(
      <WorkspacePanelCards
        currentProject={project}
        devices={cloudDevices}
        onRequestClose={onRequestClose}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-ide-card'))

    await waitFor(() => expect(api.startCodeServerSession).toHaveBeenCalledWith(7))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledWith(
      'http://localhost/ide',
      '_blank',
      'noopener,noreferrer'
    )
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  test('opens the project desktop using the cloud device VNC page', async () => {
    const onRequestClose = vi.fn()
    render(
      <WorkspacePanelCards
        currentProject={project}
        devices={cloudDevices}
        onRequestClose={onRequestClose}
      />
    )

    await userEvent.click(screen.getByTestId('workspace-desktop-card'))

    await waitFor(() => expect(getVncConfigMock).toHaveBeenCalledWith('device-1'))
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining('/vnc.html?wsUrl='),
      '_blank',
      'noopener,noreferrer'
    )
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining('sandboxId=sandbox-1'),
      '_blank',
      'noopener,noreferrer'
    )
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  test('launches the native terminal for local project devices without cloud-only tools', async () => {
    const api = createProjectApiMock()
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
    expect(api.startTerminalSession).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
    expect(screen.queryByTestId('workspace-ide-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-desktop-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('launches the native terminal in the active workspace target path', async () => {
    render(
      <WorkspacePanelCards
        currentProject={project}
        devices={localDevices}
        workspaceTarget={{
          deviceId: 'device-1',
          path: '/workspace/worktrees/8/project38',
          source: 'task',
          taskId: 8,
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
    const api = createProjectApiMock()
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
    expect(api.startTerminalSession).not.toHaveBeenCalled()
  })

  test('uses the backend remote terminal outside the WeWork macOS app', async () => {
    const api = createProjectApiMock()
    isLocalTerminalAvailableMock.mockReturnValue(false)

    render(<WorkspacePanelCards currentProject={project} devices={localDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() => expect(api.startTerminalSession).toHaveBeenCalledWith(7))
    expect(startLocalTerminalMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.queryByTestId('workspace-ide-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-desktop-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('starts remote terminal on the active runtime workspace device and path', async () => {
    const projectApi = createProjectApiMock()
    const deviceApi = createDeviceApiMock()
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
            device_type: 'local',
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
      expect(deviceApi.startTerminal).toHaveBeenCalledWith(
        'device-2',
        '/workspace/worktrees/9/project38'
      )
    )
    expect(projectApi.startTerminalSession).not.toHaveBeenCalled()
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

  test('falls back to the backend remote terminal when the local path cannot be opened', async () => {
    const api = createProjectApiMock()
    getLocalExecutorDeviceIdMock.mockResolvedValue('another-device')
    localPathExistsMock.mockResolvedValue(false)

    render(<WorkspacePanelCards currentProject={project} devices={localDevices} />)

    await userEvent.click(await screen.findByTestId('workspace-terminal-card'))

    await waitFor(() => expect(api.startTerminalSession).toHaveBeenCalledWith(7))
    expect(startLocalTerminalMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('does not show ClaudeCode-only project tools for OpenClaw devices', () => {
    render(<WorkspacePanelCards currentProject={project} devices={openClawCloudDevices} />)

    expect(screen.queryByTestId('workspace-terminal-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-ide-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-desktop-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-local-device-limited-tools')).toBeInTheDocument()
  })

  test('does not show cloud-only project tools before the bound device type is known', () => {
    render(<WorkspacePanelCards currentProject={project} devices={[]} />)

    expect(screen.queryByTestId('workspace-terminal-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-ide-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-desktop-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-local-device-limited-tools')).toBeInTheDocument()
  })

  test('marks terminal as unavailable when session probing fails', async () => {
    const api = createProjectApiMock()
    vi.mocked(api.startTerminalSession).mockRejectedValueOnce(new Error('terminal unavailable'))
    render(<WorkspacePanelCards currentProject={project} devices={cloudDevices} />)

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    await waitFor(() => expect(screen.getByTestId('workspace-terminal-card')).toBeDisabled())
    expect(screen.getByTestId('workspace-terminal-card')).toHaveTextContent('暂不可用')

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    expect(api.startTerminalSession).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('workspace-ide-card')).not.toBeDisabled()
    expect(screen.getByTestId('workspace-desktop-card')).not.toBeDisabled()
  })

  test('opens IDE even when browser preflight probing would be blocked', async () => {
    const api = createProjectApiMock()
    fetchMock.mockRejectedValueOnce(new TypeError('Mixed content blocked'))
    render(<WorkspacePanelCards currentProject={project} devices={cloudDevices} />)

    await userEvent.click(screen.getByTestId('workspace-ide-card'))

    await waitFor(() => expect(api.startCodeServerSession).toHaveBeenCalledWith(7))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(api.startCodeServerSession).toHaveBeenCalledTimes(1)
    expect(window.open).toHaveBeenCalledWith(
      'http://localhost/ide',
      '_blank',
      'noopener,noreferrer'
    )
  })

  test('marks IDE as unavailable when the returned session URL is missing', async () => {
    const api = createProjectApiMock()
    vi.mocked(api.startCodeServerSession).mockResolvedValueOnce({
      session_id: 'ide-1',
      project_id: 7,
      device_id: 'device-1',
      type: 'code_server',
      path: '/workspace/projects/project38',
      url: '',
    })
    render(<WorkspacePanelCards currentProject={project} devices={cloudDevices} />)

    await userEvent.click(screen.getByTestId('workspace-ide-card'))

    await waitFor(() => expect(screen.getByTestId('workspace-ide-card')).toBeDisabled())
    expect(window.open).not.toHaveBeenCalled()
    expect(api.startCodeServerSession).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('启动失败')
  })

  test('marks desktop as unavailable when VNC probing fails', async () => {
    getVncConfigMock.mockRejectedValueOnce(new Error('vnc unavailable'))
    render(<WorkspacePanelCards currentProject={project} devices={cloudDevices} />)

    await userEvent.click(screen.getByTestId('workspace-desktop-card'))

    await waitFor(() => expect(screen.getByTestId('workspace-desktop-card')).toBeDisabled())
    expect(screen.getByTestId('workspace-desktop-card')).toHaveTextContent('暂不可用')
    expect(window.open).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('workspace-desktop-card'))

    expect(getVncConfigMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('workspace-terminal-card')).not.toBeDisabled()
    expect(screen.getByTestId('workspace-ide-card')).not.toBeDisabled()
  })

  test('resets unavailable tools when the project changes', async () => {
    const api = createProjectApiMock()
    vi.mocked(api.startTerminalSession).mockRejectedValueOnce(new Error('terminal unavailable'))
    const nextProject = {
      ...project,
      id: 8,
      name: 'project39',
    }
    const { rerender } = render(
      <WorkspacePanelCards currentProject={project} devices={cloudDevices} />
    )

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    await waitFor(() => expect(screen.getByTestId('workspace-terminal-card')).toBeDisabled())

    rerender(<WorkspacePanelCards currentProject={nextProject} devices={cloudDevices} />)

    expect(screen.getByTestId('workspace-terminal-card')).not.toBeDisabled()
    expect(screen.getByTestId('workspace-terminal-card')).not.toHaveTextContent('暂不可用')
  })
})
