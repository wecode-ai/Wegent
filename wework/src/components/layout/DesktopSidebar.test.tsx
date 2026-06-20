import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DesktopSidebar } from './DesktopSidebar'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'

function localDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'local-device',
    name: 'Local Mac',
    status: 'online',
    is_default: true,
    device_type: 'local',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

function project(overrides: Partial<ProjectWithTasks> = {}): ProjectWithTasks {
  return {
    id: 7,
    name: 'Wegent',
    tasks: [],
    ...overrides,
  }
}

function renderSidebar(overrides: Partial<Parameters<typeof DesktopSidebar>[0]> = {}) {
  const props: Parameters<typeof DesktopSidebar>[0] = {
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    projects: [project()],
    devices: [localDevice()],
    recentTasks: [],
    runningTaskIds: new Set(),
    onCollapse: vi.fn(),
    onNewChat: vi.fn(),
    onStartStandaloneChat: vi.fn(),
    onSelectProject: vi.fn(),
    onStartNewProjectChat: vi.fn(),
    onOpenTask: vi.fn(),
    onListLocalCodexThreads: vi.fn().mockResolvedValue([]),
    onBindLocalCodexThread: vi.fn(),
    onOpenPlugins: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateGitWorkspaceProject: vi.fn(),
    onListGitRepositories: vi.fn().mockResolvedValue([]),
    onListGitBranches: vi.fn().mockResolvedValue([]),
    onUpdateProjectName: vi.fn(),
    onRemoveProject: vi.fn(),
    onArchiveAllChats: vi.fn(),
    onArchiveAllProjectChats: vi.fn(),
    onArchiveProjectChats: vi.fn(),
    onArchiveTask: vi.fn(),
    onRenameTask: vi.fn(),
    onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/Users/alice'),
    onGetProjectWorkspaceRoot: vi.fn().mockResolvedValue('/Users/alice/dev'),
    onListDeviceDirectories: vi.fn().mockResolvedValue([]),
    onCreateDeviceDirectory: vi.fn(),
    onOpenSettings: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  }

  render(<DesktopSidebar {...props} />)
  return props
}

describe('DesktopSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('opens local Codex dialog from a dedicated sidebar area', async () => {
    const onListLocalCodexThreads = vi.fn().mockResolvedValue([])

    renderSidebar({ onListLocalCodexThreads })

    expect(screen.getByTestId('local-codex-section')).toHaveTextContent('Codex')
    expect(screen.queryByTestId('local-codex-import-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('local-codex-open-button'))

    expect(await screen.findByTestId('local-codex-import-dialog')).toBeInTheDocument()
    await waitFor(() => expect(onListLocalCodexThreads).toHaveBeenCalledWith('local-device'))
  })
})
