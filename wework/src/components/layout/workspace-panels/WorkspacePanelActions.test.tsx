import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { openExternalUrl } from '@/lib/external-links'
import {
  isLocalTerminalAvailable,
  listLocalWorkspaceOpeners,
  openLocalWorkspace,
  pickLocalWorkspaceOpenerExe,
} from '@/lib/local-terminal'
import { getPreferredWorkspaceOpener } from '@/lib/workspace-opener-preferences'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspacePanelActions } from './WorkspacePanelActions'

vi.mock('@/lib/local-terminal', () => ({
  isLocalTerminalAvailable: vi.fn(),
  listLocalWorkspaceOpeners: vi.fn(),
  openLocalWorkspace: vi.fn(),
  pickLocalWorkspaceOpenerExe: vi.fn(),
}))

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

const openExternalUrlMock = vi.mocked(openExternalUrl)
const isLocalTerminalAvailableMock = vi.mocked(isLocalTerminalAvailable)
const listLocalWorkspaceOpenersMock = vi.mocked(listLocalWorkspaceOpeners)
const openLocalWorkspaceMock = vi.mocked(openLocalWorkspace)
const pickLocalWorkspaceOpenerExeMock = vi.mocked(pickLocalWorkspaceOpenerExe)

const defaultOpenersAvailability = [
  { id: 'vscode', category: 'general', available: true },
  { id: 'vscode-insiders', category: 'general', available: true },
  { id: 'cursor', category: 'general', available: true },
  { id: 'sublime-text', category: 'general', available: true },
  { id: 'windsurf', category: 'general', available: true },
  { id: 'intellij-idea', category: 'general', available: true },
  { id: 'android-studio', category: 'general', available: true },
  { id: 'file-manager', category: 'fileManager', available: true },
  { id: 'terminal', category: 'terminal', available: true },
  { id: 'xcode', category: 'macOnly', available: true },
  { id: 'iterm2', category: 'macOnly', available: true },
  { id: 'ghostty', category: 'macOnly', available: true },
  { id: 'warp', category: 'macOnly', available: true },
] as const
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
const originalUserAgent = window.navigator.userAgent

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
  rightPanelExpanded: false,
  bottomPanelOpen: false,
  onToggleRightPanel: vi.fn(),
  onToggleRightPanelExpanded: vi.fn(),
  onToggleBottomPanel: vi.fn(),
  workspaceSessionApi,
}

describe('WorkspacePanelActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setWindowWidth(originalInnerWidth)
    isLocalTerminalAvailableMock.mockReturnValue(false)
    openLocalWorkspaceMock.mockResolvedValue(undefined)
    listLocalWorkspaceOpenersMock.mockResolvedValue([...defaultOpenersAvailability])
    pickLocalWorkspaceOpenerExeMock.mockResolvedValue(null)
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
    vi.useRealTimers()
    setWindowWidth(originalInnerWidth)
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    })
  })

  test('keeps the right panel toggle available', async () => {
    const user = userEvent.setup()
    render(<WorkspacePanelActions {...baseProps} mode="right-panel-toggle" />)
    const toggle = screen.getByTestId('toggle-right-workspace-panel-button')
    expect(toggle).toBeEnabled()
    await user.click(toggle)
    expect(baseProps.onToggleRightPanel).toHaveBeenCalledOnce()
  })

  test('remembers and prioritizes the last successful titlebar IDE selection', async () => {
    isLocalTerminalAvailableMock.mockReturnValue(true)
    const actions = (
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
    const { unmount } = render(actions)
    const menuOptionIds = () =>
      within(screen.getByTestId('open-local-workspace-picker-menu'))
        .getAllByRole('menuitem')
        .map(option => option.getAttribute('data-testid'))

    await userEvent.click(screen.getByTestId('open-local-workspace-picker-button'))

    expect(screen.getByTestId('open-local-workspace-picker-menu')).toBeInTheDocument()
    const initialOrder = menuOptionIds()
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
    await waitFor(() =>
      expect(getPreferredWorkspaceOpener('/Users/me/project38')).toBe('intellij-idea')
    )
    const preferredOrder = [
      'open-local-workspace-option-intellij-idea',
      ...initialOrder.filter(id => id !== 'open-local-workspace-option-intellij-idea'),
    ]
    await userEvent.click(screen.getByTestId('open-local-workspace-picker-button'))
    expect(menuOptionIds()).toEqual(preferredOrder)
    await userEvent.keyboard('{Escape}')

    unmount()
    render(actions)
    await userEvent.click(screen.getByTestId('open-local-workspace-picker-button'))
    expect(menuOptionIds()).toEqual(preferredOrder)
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))
    expect(openLocalWorkspaceMock).toHaveBeenLastCalledWith({
      opener: 'intellij-idea',
      path: '/Users/me/project38',
    })

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      openLocalWorkspaceMock.mockRejectedValueOnce(new Error('Application launch failed'))
      await userEvent.click(screen.getByTestId('open-local-workspace-picker-button'))
      await userEvent.click(screen.getByTestId('open-local-workspace-option-cursor'))
      await waitFor(() => expect(consoleError).toHaveBeenCalled())
      expect(openLocalWorkspaceMock).toHaveBeenLastCalledWith({
        opener: 'cursor',
        path: '/Users/me/project38',
      })
      expect(getPreferredWorkspaceOpener('/Users/me/project38')).toBe('intellij-idea')
      await userEvent.click(screen.getByTestId('open-local-workspace-picker-button'))
      expect(menuOptionIds()).toEqual(preferredOrder)
      await userEvent.keyboard('{Escape}')
    } finally {
      consoleError.mockRestore()
    }

    listLocalWorkspaceOpenersMock.mockResolvedValue(
      defaultOpenersAvailability.map(opener => ({
        ...opener,
        available: opener.available && opener.id !== 'intellij-idea',
      }))
    )
    await userEvent.click(screen.getByTestId('open-local-workspace-picker-button'))
    expect(menuOptionIds()).toEqual(
      initialOrder.filter(id => id !== 'open-local-workspace-option-intellij-idea')
    )
    expect(
      screen.queryByTestId('open-local-workspace-option-intellij-idea')
    ).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))
    expect(openLocalWorkspaceMock).toHaveBeenLastCalledWith({
      opener: 'vscode',
      path: '/Users/me/project38',
    })
  })

  test('on Windows, hides unavailable openers and lets the user add a custom opener', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    })
    isLocalTerminalAvailableMock.mockReturnValue(true)
    listLocalWorkspaceOpenersMock.mockResolvedValue([
      { id: 'vscode', category: 'general', available: true },
      { id: 'intellij-idea', category: 'general', available: false },
      { id: 'cmd', category: 'winOnly', available: true },
      { id: 'powershell', category: 'winOnly', available: true },
      { id: 'custom', category: 'general', available: true, label: 'Helix' },
    ])

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
    expect(screen.getByTestId('open-local-workspace-option-vscode')).toBeInTheDocument()
    expect(screen.getByTestId('open-local-workspace-option-cmd')).toBeInTheDocument()
    expect(screen.getByTestId('open-local-workspace-option-powershell')).toBeInTheDocument()
    expect(screen.getByTestId('open-local-workspace-option-custom')).toHaveTextContent('Helix')
    expect(
      screen.queryByTestId('open-local-workspace-option-intellij-idea')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('open-local-workspace-choose-other-button')).toBeInTheDocument()

    pickLocalWorkspaceOpenerExeMock.mockResolvedValue('C:\\Tools\\Helix\\hx.exe')
    listLocalWorkspaceOpenersMock.mockResolvedValueOnce([
      { id: 'vscode', category: 'general', available: true },
      { id: 'cmd', category: 'winOnly', available: true },
      { id: 'powershell', category: 'winOnly', available: true },
      { id: 'custom', category: 'general', available: true, label: 'Neovim' },
    ])
    await userEvent.click(screen.getByTestId('open-local-workspace-choose-other-button'))

    await waitFor(() => expect(pickLocalWorkspaceOpenerExeMock).toHaveBeenCalled())
    expect(await screen.findByTestId('open-local-workspace-option-custom')).toHaveTextContent(
      'Neovim'
    )
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
})
