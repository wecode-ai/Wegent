import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createDeviceApi } from '@/api/devices'
import { createProjectApi } from '@/api/projects'
import { WorkspacePanelCards } from './WorkspacePanelCards'

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({ apiBaseUrl: '/api' }),
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

const createDeviceApiMock = vi.mocked(createDeviceApi)
const createProjectApiMock = vi.mocked(createProjectApi)
const getVncConfigMock = vi.fn()

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

describe('WorkspacePanelCards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'open').mockImplementation(() => null)
    window.localStorage.setItem('auth_token', 'token-1')
    let terminalSessionCount = 0
    createProjectApiMock.mockReturnValue({
      startTerminalSession: vi.fn().mockImplementation(async () => {
        terminalSessionCount += 1
        return {
          session_id: `terminal-${terminalSessionCount}`,
          url: `http://localhost/terminal-${terminalSessionCount}`,
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
    } as unknown as ReturnType<typeof createDeviceApi>)
    getVncConfigMock.mockResolvedValue({
      wss_url: 'wss://example.com/vnc',
      signature: 'signature',
      sandbox_id: 'sandbox-1',
    })
  })

  test('renders terminal, IDE, and desktop project tools', () => {
    render(<WorkspacePanelCards currentProject={project} />)

    expect(screen.queryByTestId('workspace-browser-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-card')).toHaveTextContent('终端')
    expect(screen.getByTestId('workspace-ide-card')).toHaveTextContent('IDE')
    expect(screen.getByTestId('workspace-desktop-card')).toHaveTextContent('桌面')
  })

  test('embeds the project terminal in the workspace panel', async () => {
    const api = createProjectApiMock()
    render(<WorkspacePanelCards currentProject={project} />)

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))

    await waitFor(() =>
      expect(api.startTerminalSession).toHaveBeenCalledWith(7),
    )
    expect(screen.getByTestId('workspace-terminal-frame')).toHaveAttribute(
      'src',
      'http://localhost/terminal-1?embed=1',
    )
    expect(screen.getByTestId('workspace-terminal-window')).toHaveClass(
      'bg-white',
    )
    expect(screen.getByTestId('workspace-terminal-tab')).toHaveTextContent(
      'device-1',
    )
    expect(screen.getByTestId('workspace-terminal-new-tab-button')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-close-button')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/projects/project38')).not.toBeInTheDocument()
  })

  test('creates and switches to a new project terminal tab', async () => {
    const api = createProjectApiMock()
    render(<WorkspacePanelCards currentProject={project} />)

    await userEvent.click(screen.getByTestId('workspace-terminal-card'))
    await waitFor(() =>
      expect(screen.getByTestId('workspace-terminal-frame')).toHaveAttribute(
        'src',
        'http://localhost/terminal-1?embed=1',
      ),
    )

    await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))

    await waitFor(() =>
      expect(api.startTerminalSession).toHaveBeenCalledTimes(2),
    )
    expect(screen.getAllByTestId('workspace-terminal-tab')).toHaveLength(2)
    expect(screen.getAllByTestId('workspace-terminal-close-button')).toHaveLength(2)
    expect(screen.getByTestId('workspace-terminal-frame')).toHaveAttribute(
      'src',
      'http://localhost/terminal-2?embed=1',
    )

    await userEvent.click(screen.getAllByTestId('workspace-terminal-close-button')[1])

    expect(screen.getAllByTestId('workspace-terminal-tab')).toHaveLength(1)
    expect(screen.getByTestId('workspace-terminal-frame')).toHaveAttribute(
      'src',
      'http://localhost/terminal-1?embed=1',
    )
  })

  test('opens the project IDE in a new page', async () => {
    const api = createProjectApiMock()
    const onRequestClose = vi.fn()
    render(<WorkspacePanelCards currentProject={project} onRequestClose={onRequestClose} />)

    await userEvent.click(screen.getByTestId('workspace-ide-card'))

    await waitFor(() =>
      expect(api.startCodeServerSession).toHaveBeenCalledWith(7),
    )
    expect(window.open).toHaveBeenCalledWith(
      'http://localhost/ide',
      '_blank',
      'noopener',
    )
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  test('opens the project desktop using the cloud device VNC page', async () => {
    const onRequestClose = vi.fn()
    render(<WorkspacePanelCards currentProject={project} onRequestClose={onRequestClose} />)

    await userEvent.click(screen.getByTestId('workspace-desktop-card'))

    await waitFor(() =>
      expect(getVncConfigMock).toHaveBeenCalledWith('device-1'),
    )
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining('/vnc.html?wsUrl='),
      '_blank',
      'noopener',
    )
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining('sandboxId=sandbox-1'),
      '_blank',
      'noopener',
    )
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })
})
