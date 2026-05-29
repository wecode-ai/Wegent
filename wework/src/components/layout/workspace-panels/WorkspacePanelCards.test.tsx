import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createProjectApi } from '@/api/projects'
import { cloudDeviceInternalApis } from '@wecode/api/devices'
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

vi.mock('@wecode/api/devices', () => ({
  cloudDeviceInternalApis: {
    getVncConfig: vi.fn(),
  },
}))

const createProjectApiMock = vi.mocked(createProjectApi)
const getVncConfigMock = vi.mocked(cloudDeviceInternalApis.getVncConfig)

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
    createProjectApiMock.mockReturnValue({
      startTerminalSession: vi.fn().mockResolvedValue({
        url: 'http://localhost/terminal',
        path: '/workspace/projects/project38',
      }),
      startCodeServerSession: vi.fn().mockResolvedValue({
        url: 'http://localhost/ide',
        path: '/workspace/projects/project38',
      }),
    } as unknown as ReturnType<typeof createProjectApi>)
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
      'http://localhost/terminal',
    )
    expect(screen.getByText('/workspace/projects/project38')).toBeInTheDocument()
  })

  test('opens the project IDE in a new page', async () => {
    const api = createProjectApiMock()
    render(<WorkspacePanelCards currentProject={project} />)

    await userEvent.click(screen.getByTestId('workspace-ide-card'))

    await waitFor(() =>
      expect(api.startCodeServerSession).toHaveBeenCalledWith(7),
    )
    expect(window.open).toHaveBeenCalledWith(
      'http://localhost/ide',
      '_blank',
      'noopener',
    )
  })

  test('opens the project desktop using the cloud device VNC page', async () => {
    render(<WorkspacePanelCards currentProject={project} />)

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
  })
})
