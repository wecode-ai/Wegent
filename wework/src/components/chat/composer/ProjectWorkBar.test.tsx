import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import '@/i18n'
import { installDshUiTestContributions } from '@/test/setup.dom'
import type { DeviceInfo, ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ProjectWorkBar as HostProjectWorkBar } from './ProjectWorkBar'

function ProjectWorkBar(
  props: ComponentProps<typeof HostProjectWorkBar> & Record<string, unknown>
) {
  return <HostProjectWorkBar {...props} extensionContext={props} />
}

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

const localDevice: DeviceInfo = {
  ...device,
  id: 3,
  device_id: 'local-device',
  name: 'Local Device',
  device_type: 'local',
  client_ip: '127.0.0.1',
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
          tasks: [],
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
          tasks: [],
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
          tasks: [],
        },
      ],
    },
  ],
  chats: [],
  totalTasks: 0,
}

const availableWorktree = {
  available: true,
  reason: 'available',
  deviceId: 'device-1',
  sourcePath: '/repo/Wegent',
} as const

describe('ProjectWorkBar', () => {
  beforeEach(async () => {
    await installDshUiTestContributions(
      {
        [WEWORK_DSH_SLOTS.projectCreateSection]: [
          {
            id: 'git-project-create',
            module: 'plugins/wework-ui-git-project-create-section.js',
          },
        ],
        [WEWORK_DSH_SLOTS.projectWorkSection]: [
          {
            id: 'git-project-work',
            module: 'plugins/wework-ui-git-project-work-section.js',
          },
        ],
      },
      {
        'plugins/wework-ui-git-project-create-section.js': () =>
          import('../../../../dsh/ui-git/src/project-create-section'),
        'plugins/wework-ui-git-project-work-section.js': () =>
          import('../../../../dsh/ui-git/src/project-work-section'),
      }
    )
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
          totalTasks: 0,
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

  test('trusts runtime preflight when stored project metadata is stale', async () => {
    const onExecutionModeChange = vi.fn()

    render(
      <ProjectWorkBar
        projects={[nonGitProject]}
        devices={[device]}
        runtimeWork={runtimeWork}
        currentProject={nonGitProject}
        currentProjectId={nonGitProject.id}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={201}
        executionMode="current_workspace"
        worktreeAvailability={{
          available: true,
          reason: 'available',
          deviceId: 'device-1',
          sourcePath: '/workspace/notes',
        }}
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={onExecutionModeChange}
      />
    )

    await userEvent.click(screen.getByTestId('execution-mode-button'))
    await userEvent.click(screen.getByTestId('execution-mode-git-worktree-button'))

    expect(onExecutionModeChange).toHaveBeenCalledWith('git_worktree')
  })

  test('keeps launch mode locked while an existing task is open', async () => {
    const onExecutionModeChange = vi.fn()

    render(
      <ProjectWorkBar
        projects={[project]}
        devices={[localDevice]}
        currentProject={project}
        currentProjectId={project.id}
        currentStandaloneDeviceId={null}
        executionMode="current_workspace"
        executionModeLocked
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onExecutionModeChange={onExecutionModeChange}
      />
    )

    expect(screen.getByTestId('execution-mode-button')).toHaveAttribute('role', 'status')
    await userEvent.click(screen.getByTestId('execution-mode-button'))

    expect(screen.queryByTestId('project-execution-mode-menu')).not.toBeInTheDocument()
    expect(onExecutionModeChange).not.toHaveBeenCalled()
  })

  test('shows a stable unavailable reason for a non-Git remote project', async () => {
    render(
      <ProjectWorkBar
        projects={[nonGitProject]}
        devices={[device]}
        runtimeWork={runtimeWork}
        currentProject={nonGitProject}
        currentProjectId={nonGitProject.id}
        currentStandaloneDeviceId={null}
        selectedDeviceWorkspaceId={201}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onSelectProjectWorkspace={vi.fn()}
        onExecutionModeChange={vi.fn()}
        branchName="main"
        onListBranches={vi.fn().mockResolvedValue(['main'])}
        onCheckoutBranch={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-work-remote-status')).toHaveTextContent('10.201.3.200')
    await userEvent.click(screen.getByTestId('execution-mode-button'))
    expect(screen.getByTestId('execution-mode-git-worktree-button')).toBeDisabled()
    expect(screen.getByTestId('execution-mode-worktree-unavailable-reason')).toHaveTextContent(
      '当前工作区不是 Git 仓库'
    )
    expect(screen.queryByTestId('project-branch-button')).not.toBeInTheDocument()
  })

  test('identifies project directories and unbound projects before selection', async () => {
    const onBindProjectWorkspace = vi.fn()
    const work: RuntimeWorkListResponse = {
      ...runtimeWork,
      projects: [
        runtimeWork.projects[1],
        {
          project: {
            id: 9,
            key: 'desktop-project',
            name: 'Desktop',
            roots: [{ kind: 'local', path: '/Users/test/Workspace/Desktop' }],
          },
          deviceWorkspaces: [],
        },
      ],
    }

    render(
      <ProjectWorkBar
        projects={[]}
        devices={[device]}
        runtimeWork={work}
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
    expect(screen.getByTestId('project-option-detail-8')).toHaveTextContent('/workspace/notes')
    expect(screen.getByTestId('project-option-detail-8')).toHaveAttribute(
      'title',
      '/workspace/notes'
    )
    expect(screen.getByTestId('project-option-9')).toHaveTextContent('未绑定设备工作区')
    expect(screen.getByTestId('project-option-detail-9')).toHaveTextContent('…/Workspace/Desktop')
    expect(screen.getByTestId('project-option-detail-9')).toHaveAttribute(
      'title',
      '/Users/test/Workspace/Desktop'
    )
    expect(screen.getByTestId('project-bind-workspace-9')).toHaveTextContent('绑定设备工作区')

    await userEvent.type(screen.getByTestId('project-search-input'), '/workspace/notes')
    expect(screen.getByTestId('project-option-8')).toBeInTheDocument()
    expect(screen.queryByTestId('project-option-9')).not.toBeInTheDocument()
    await userEvent.clear(screen.getByTestId('project-search-input'))
    await userEvent.click(screen.getByTestId('project-option-9'))
    expect(onBindProjectWorkspace).toHaveBeenCalledWith(9)
  })

  test('checks out a selected branch in local execution mode', async () => {
    const onListBranches = vi.fn().mockResolvedValue(['main', 'develop'])
    const onCheckoutBranch = vi.fn().mockResolvedValue(undefined)

    render(
      <ProjectWorkBar
        projects={[project]}
        devices={[localDevice]}
        currentProject={project}
        currentProjectId={project.id}
        currentStandaloneDeviceId={null}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onExecutionModeChange={vi.fn()}
        branchName="main"
        branchLoading={false}
        onListBranches={onListBranches}
        onCheckoutBranch={onCheckoutBranch}
      />
    )

    await userEvent.click(screen.getByTestId('project-branch-button'))

    const menu = await screen.findByTestId('project-branch-menu')
    expect(menu).toHaveClass('right-0')
    expect(menu).not.toHaveClass('left-0')
    await waitFor(() => expect(onListBranches).toHaveBeenCalledTimes(1))
    await userEvent.click(within(menu).getByText('develop'))

    expect(onCheckoutBranch).toHaveBeenCalledWith('develop')
  })

  test('checks out the selected branch even when its name matches the cached current branch', async () => {
    const onCheckoutBranch = vi.fn()

    render(
      <ProjectWorkBar
        projects={[project]}
        devices={[localDevice]}
        currentProject={project}
        currentProjectId={project.id}
        currentStandaloneDeviceId={null}
        executionMode="current_workspace"
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onExecutionModeChange={vi.fn()}
        branchName="main"
        branchLoading={false}
        onListBranches={vi.fn().mockResolvedValue(['main', 'develop'])}
        onCheckoutBranch={onCheckoutBranch}
      />
    )

    await userEvent.click(screen.getByTestId('project-branch-button'))
    const menu = await screen.findByTestId('project-branch-menu')
    await userEvent.click(within(menu).getByText('main'))

    expect(onCheckoutBranch).toHaveBeenCalledWith('main')
    await waitFor(() => expect(screen.queryByTestId('project-branch-menu')).not.toBeInTheDocument())
  })

  test('does not invent a worktree branch when the current branch is unavailable', async () => {
    const onWorktreeBranchChange = vi.fn()
    const onListBranches = vi.fn().mockResolvedValue(['main', 'develop'])

    render(
      <ProjectWorkBar
        projects={[project]}
        devices={[device]}
        currentProject={project}
        currentProjectId={project.id}
        currentStandaloneDeviceId={null}
        executionMode="git_worktree"
        worktreeAvailability={availableWorktree}
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onExecutionModeChange={vi.fn()}
        branchName=""
        branchLoading={false}
        onListBranches={onListBranches}
        onCheckoutBranch={vi.fn()}
        worktreeBranch={null}
        onWorktreeBranchChange={onWorktreeBranchChange}
      />
    )

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(screen.getByTestId('project-worktree-branch-button')).toHaveTextContent('选择分支')
    expect(onListBranches).not.toHaveBeenCalled()
    expect(onWorktreeBranchChange).not.toHaveBeenCalled()
  })

  test('shows the inherited branch while execution controls are locked', () => {
    render(
      <ProjectWorkBar
        projects={[project]}
        devices={[localDevice]}
        currentProject={project}
        currentProjectId={project.id}
        currentStandaloneDeviceId={null}
        executionMode="git_worktree"
        executionModeLocked
        onSelectProject={vi.fn()}
        onSelectStandaloneDevice={vi.fn()}
        onExecutionModeChange={vi.fn()}
        branchName="feature/login"
        branchLoading={false}
      />
    )

    expect(screen.getByTestId('execution-mode-button')).toHaveTextContent('新工作树')
    expect(screen.getByTestId('project-work-branch-readonly')).toHaveTextContent('feature/login')
    expect(screen.queryByTestId('project-worktree-branch-button')).not.toBeInTheDocument()
  })
})
