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
  client_ip: '10.201.3.200',
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
  chats: [],
  totalLocalTasks: 0,
}

describe('ProjectWorkBar', () => {
  test('shows empty project list and grouped project creation actions', async () => {
    const onCreateProjectMode = vi.fn()

    render(
      <ProjectWorkBar
        projects={[]}
        devices={[device]}
        runtimeWork={{
          projects: [],
          chats: [],
          totalLocalTasks: 0,
        }}
        currentProjectId={undefined}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={null}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={vi.fn()}
        onCreateProjectMode={onCreateProjectMode}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    expect(screen.getByText('暂无项目')).toBeInTheDocument()
    expect(screen.getByTestId('add-local-project-option')).toHaveTextContent('添加本地项目')
    expect(screen.getByTestId('add-remote-project-option')).toHaveTextContent('添加远程项目')
    expect(screen.getByTestId('no-project-option')).toHaveTextContent('不使用项目')
    expect(screen.queryByTestId('standalone-device-list')).not.toBeInTheDocument()

    await userEvent.hover(screen.getByTestId('add-local-project-option'))

    expect(screen.getByTestId('add-local-project-submenu')).toBeInTheDocument()
    expect(screen.getByTestId('add-local-blank-project-option')).toHaveTextContent('新建空白项目')
    expect(screen.getByTestId('add-local-existing-project-option')).toHaveTextContent(
      '使用现有文件夹'
    )

    await userEvent.click(screen.getByTestId('add-local-existing-project-option'))

    expect(onCreateProjectMode).toHaveBeenCalledWith('existing')
  })

  test('opens remote project creation from the project work menu', async () => {
    const onCreateProjectMode = vi.fn()

    render(
      <ProjectWorkBar
        projects={[]}
        devices={[device]}
        runtimeWork={{
          projects: [],
          chats: [],
          totalLocalTasks: 0,
        }}
        currentProjectId={undefined}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={null}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={vi.fn()}
        onCreateProjectMode={onCreateProjectMode}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('add-remote-project-option'))

    expect(onCreateProjectMode).toHaveBeenCalledWith('git')
  })

  test('lists runtime projects when the regular project list is empty', async () => {
    const onSelectProjectWorkspace = vi.fn()

    render(
      <ProjectWorkBar
        projects={[]}
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

    expect(screen.queryByText('暂无项目')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-option-7')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('project-option-8')).toHaveTextContent('Notes')

    await userEvent.click(screen.getByTestId('project-option-8'))

    expect(onSelectProjectWorkspace).toHaveBeenCalledWith(8, 201)
  })

  test('keeps local workspace device details out of the workbar summary', () => {
    const localDevice: DeviceInfo = {
      ...device,
      name: 'macOS-Device-180c94f9f841',
      device_type: 'local',
      client_ip: '10.201.3.200',
    }

    render(
      <ProjectWorkBar
        projects={[project]}
        devices={[localDevice]}
        runtimeWork={runtimeWork}
        currentProject={project}
        currentProjectId={project.id}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={101}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('project-work-button')).not.toHaveTextContent('macOS-Device')
    expect(screen.getByTestId('project-work-button')).not.toHaveTextContent('10.201.3.200')
    expect(screen.getByTestId('execution-mode-button')).toHaveTextContent('本地模式')
    expect(screen.queryByTestId('project-work-remote-status')).not.toBeInTheDocument()
  })

  test('shows remote mode separately from the project name and right-aligns the remote IP', () => {
    render(
      <ProjectWorkBar
        projects={[project]}
        devices={[device]}
        runtimeWork={runtimeWork}
        currentProject={project}
        currentProjectId={project.id}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={101}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('project-work-button')).not.toHaveTextContent('远程')
    expect(screen.getByTestId('execution-mode-button')).toHaveTextContent('远程')
    expect(screen.getByTestId('project-work-remote-status')).toHaveTextContent('10.201.3.200')
    expect(screen.getByTestId('project-work-remote-status')).toHaveClass('ml-auto')
  })

  test('hides remote status while no project is selected', () => {
    render(
      <ProjectWorkBar
        projects={[]}
        devices={[device]}
        runtimeWork={runtimeWork}
        currentProject={null}
        currentProjectId={undefined}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={101}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('进入项目工作')
    expect(screen.queryByTestId('execution-mode-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-work-remote-status')).not.toBeInTheDocument()
  })

  test('resolves the selected workspace within the current project before showing remote state', () => {
    const localDevice: DeviceInfo = {
      ...device,
      name: 'macOS-Device-180c94f9f841',
      device_type: 'local',
      client_ip: '10.201.3.200',
    }

    render(
      <ProjectWorkBar
        projects={[project, nonGitProject]}
        devices={[localDevice]}
        runtimeWork={runtimeWork}
        currentProject={nonGitProject}
        currentProjectId={nonGitProject.id}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={101}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('Notes')
    expect(screen.getByTestId('execution-mode-button')).toHaveTextContent('本地模式')
    expect(screen.queryByTestId('project-work-remote-status')).not.toBeInTheDocument()
  })

  test('selects the local device when choosing no project', async () => {
    const onSelectStandaloneDevice = vi.fn()
    const localDevice: DeviceInfo = {
      ...device,
      id: 2,
      device_id: 'local-device',
      name: 'macOS Local',
      device_type: 'local',
    }
    const remoteDevice: DeviceInfo = {
      ...device,
      id: 3,
      device_id: 'remote-device',
      name: 'Remote Host',
      device_type: 'remote',
    }

    render(
      <ProjectWorkBar
        projects={[]}
        devices={[remoteDevice, localDevice]}
        runtimeWork={{
          projects: [],
          chats: [],
          totalLocalTasks: 0,
        }}
        currentProjectId={undefined}
        currentStandaloneDeviceId="remote-device"
        selectedDeviceWorkspaceId={null}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={onSelectStandaloneDevice}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('no-project-option'))

    expect(onSelectStandaloneDevice).toHaveBeenCalledWith('local-device')
  })

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

  test('shows the device summary for a single-workspace project row', async () => {
    const projectWithoutLegacyDevice: ProjectWithTasks = {
      id: 8,
      name: 'Notes',
      tasks: [],
      config: { mode: 'workspace' },
    }

    render(
      <ProjectWorkBar
        projects={[projectWithoutLegacyDevice]}
        devices={[device]}
        runtimeWork={runtimeWork}
        currentProjectId={8}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={201}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const option = screen.getByTestId('project-option-8')
    expect(option).toHaveTextContent('10.201.3.200')
    expect(option).toHaveTextContent('在线')
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

  test('does not read project rows without runtime workspaces', async () => {
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
          chats: [],
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

    expect(screen.getByText('暂无项目')).toBeInTheDocument()
    expect(screen.queryByTestId('project-bind-workspace-9')).not.toBeInTheDocument()
    expect(onBindProjectWorkspace).not.toHaveBeenCalled()
  })

  test('shows local mode but hides worktree controls when the project directory is not a git repository', async () => {
    const user = userEvent.setup()

    render(
      <ProjectWorkBar
        projects={[nonGitProject]}
        devices={[device]}
        currentProject={nonGitProject}
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
        currentProject={nonGitProject}
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
        currentProject={project}
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
