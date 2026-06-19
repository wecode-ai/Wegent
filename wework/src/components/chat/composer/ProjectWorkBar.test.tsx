import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ProjectWorkBar } from './ProjectWorkBar'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'

const project: ProjectWithTasks = {
  id: 7,
  name: 'Wegent',
  tasks: [],
  config: {
    mode: 'workspace',
    execution: {
      targetType: 'local',
      deviceId: 'device-1',
    },
    workspace: {
      source: 'git',
      checkoutPath: 'projects/Wegent',
    },
  },
}

const nonGitProject: ProjectWithTasks = {
  id: 8,
  name: 'Notes',
  tasks: [],
  config: {
    mode: 'workspace',
    execution: {
      targetType: 'local',
      deviceId: 'device-1',
    },
    workspace: {
      source: 'local_path',
      localPath: '/workspace/notes',
    },
  },
}

const device: DeviceInfo = {
  id: 1,
  device_id: 'device-1',
  name: 'Local Device',
  status: 'online',
  is_default: true,
  device_type: 'cloud',
  bind_shell: 'claudecode',
  executor_version: '1.8.5',
  direct_chat: {
    enabled: true,
    transport: 'socket.io',
    base_url: 'http://127.0.0.1:17889',
    socket_path: '/socket.io',
    namespace: '/wework-chat',
    version: 1,
  },
}

describe('ProjectWorkBar', () => {
  test('shows local mode but hides worktree controls when the project directory is not a git repository', async () => {
    const user = userEvent.setup()

    render(
      <ProjectWorkBar
        projects={[nonGitProject]}
        devices={[device]}
        currentProjectId={nonGitProject.id}
        currentStandaloneDeviceId={null}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onExecutionModeChange={vi.fn()}
        branchName=""
        branchLoading={false}
        onListBranches={vi.fn().mockResolvedValue([])}
        onCheckoutBranch={vi.fn()}
        worktreeBaseBranch={null}
        onWorktreeBaseBranchChange={vi.fn()}
      />
    )

    const executionModeButton = screen.getByTestId('execution-mode-button')
    expect(executionModeButton).toHaveTextContent('本地模式')
    expect(screen.queryByTestId('project-worktree-branch-button')).not.toBeInTheDocument()

    await user.click(executionModeButton)

    expect(screen.queryByTestId('project-execution-mode-menu')).not.toBeInTheDocument()
  })

  test('falls back from worktree mode when the project directory is not a git repository', async () => {
    const onExecutionModeChange = vi.fn()

    render(
      <ProjectWorkBar
        projects={[nonGitProject]}
        devices={[device]}
        currentProjectId={nonGitProject.id}
        currentStandaloneDeviceId={null}
        executionMode="git_worktree"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onExecutionModeChange={onExecutionModeChange}
        branchName=""
        branchLoading={false}
        onListBranches={vi.fn().mockResolvedValue([])}
        onCheckoutBranch={vi.fn()}
        worktreeBaseBranch={null}
        onWorktreeBaseBranchChange={vi.fn()}
      />
    )

    await waitFor(() => expect(onExecutionModeChange).toHaveBeenCalledWith('current_workspace'))
  })

  test('shows source branch selector after selecting new worktree', async () => {
    const onWorktreeBaseBranchChange = vi.fn()
    const onListBranches = vi.fn().mockResolvedValue(['main', 'develop'])

    render(
      <ProjectWorkBar
        projects={[project]}
        devices={[device]}
        currentProjectId={project.id}
        currentStandaloneDeviceId={null}
        executionMode="git_worktree"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onExecutionModeChange={vi.fn()}
        branchName="main"
        onListBranches={onListBranches}
        onCheckoutBranch={vi.fn()}
        worktreeBaseBranch="main"
        onWorktreeBaseBranchChange={onWorktreeBaseBranchChange}
      />
    )

    expect(screen.getByTestId('project-worktree-branch-button')).toHaveTextContent('main')
    expect(screen.queryByTestId('project-branch-button')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-worktree-branch-button'))

    const menu = await screen.findByTestId('project-worktree-branch-menu')
    await waitFor(() => expect(onListBranches).toHaveBeenCalledTimes(1))
    expect(within(menu).getByText('develop')).toBeInTheDocument()

    await userEvent.click(within(menu).getByText('develop'))

    expect(onWorktreeBaseBranchChange).toHaveBeenCalledWith('develop')
  })
})
