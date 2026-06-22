import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ProjectWorkBar } from './ProjectWorkBar'
import type { DeviceInfo, ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'

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
}

const runtimeWork: RuntimeWorkListResponse = {
  projects: [
    {
      project: { id: 7, name: 'Wegent' },
      deviceWorkspaces: [
        {
          id: 101,
          projectId: 7,
          deviceId: 'device-1',
          deviceName: 'Local Device',
          deviceStatus: 'online',
          available: true,
          workspacePath: '/repo/Wegent',
          mapped: true,
          localTasks: [],
        },
        {
          id: 102,
          projectId: 7,
          deviceId: 'device-2',
          deviceName: 'Offline Device',
          deviceStatus: 'offline',
          available: false,
          workspacePath: '/repo/Wegent',
          mapped: true,
          localTasks: [],
        },
      ],
    },
    {
      project: { id: 8, name: 'Notes' },
      deviceWorkspaces: [
        {
          id: 201,
          projectId: 8,
          deviceId: 'device-1',
          deviceName: 'Local Device',
          deviceStatus: 'online',
          available: true,
          workspacePath: '/workspace/notes',
          mapped: true,
          localTasks: [],
        },
      ],
    },
  ],
  unmappedDeviceWorkspaces: [],
  totalLocalTasks: 0,
}

describe('ProjectWorkBar', () => {
  test('selects a single-workspace project directly', async () => {
    const onSelectProjectWorkspace = vi.fn()

    render(
      <ProjectWorkBar
        projects={[project, nonGitProject]}
        devices={[device]}
        runtimeWork={runtimeWork}
        currentProjectId={undefined}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={null}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={onSelectProjectWorkspace}
        onExecutionModeChange={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('project-option-8'))

    expect(onSelectProjectWorkspace).toHaveBeenCalledWith(8, 201)
  })

  test('expands a multi-workspace project before selection', async () => {
    const onSelectProjectWorkspace = vi.fn()

    render(
      <ProjectWorkBar
        projects={[project]}
        devices={[device]}
        runtimeWork={runtimeWork}
        currentProjectId={7}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={null}
        pendingProjectWorkspaceProjectId={7}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={onSelectProjectWorkspace}
        onExecutionModeChange={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByTestId('project-workspace-option-101')).toHaveTextContent('Local Device')
    expect(screen.getByTestId('project-workspace-option-102')).toBeDisabled()

    await userEvent.click(screen.getByTestId('project-workspace-option-101'))

    expect(onSelectProjectWorkspace).toHaveBeenCalledWith(7, 101)
  })

  test('opens workspace binding for projects without mapped workspaces', async () => {
    const onBindProjectWorkspace = vi.fn()
    const emptyProject: ProjectWithTasks = {
      id: 9,
      name: 'Empty Project',
      tasks: [],
      config: { mode: 'workspace' },
    }

    render(
      <ProjectWorkBar
        projects={[emptyProject]}
        devices={[device]}
        runtimeWork={{
          projects: [],
          unmappedDeviceWorkspaces: [],
          totalLocalTasks: 0,
        }}
        currentProjectId={undefined}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={null}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onBindProjectWorkspace={onBindProjectWorkspace}
        onExecutionModeChange={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('project-bind-workspace-9'))

    expect(onBindProjectWorkspace).toHaveBeenCalledWith(9)
  })

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
