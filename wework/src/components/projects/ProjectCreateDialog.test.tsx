import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { DeviceInfo, GitBranch, GitRepoInfo, ProjectWithTasks } from '@/types/api'
import '@/i18n'
import { ProjectCreateDialog } from './ProjectCreateDialog'

const devices: DeviceInfo[] = [
  {
    id: 1,
    device_id: 'cloud-device',
    name: 'Cloud Device',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
  },
  {
    id: 2,
    device_id: 'local-device',
    name: 'Local Device',
    status: 'online',
    is_default: false,
    device_type: 'local',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
  },
]

const repositories: GitRepoInfo[] = [
  {
    git_repo_id: 101,
    name: 'Wegent',
    git_repo: 'wecode-ai/Wegent',
    git_url: 'https://github.com/wecode-ai/Wegent.git',
    git_domain: 'github.com',
    namespace: 'wecode-ai',
    private: false,
    type: 'github',
  },
]

const branches: GitBranch[] = [
  { name: 'main', default: true, protected: false },
  { name: 'develop', default: false, protected: false },
]

describe('ProjectCreateDialog', () => {
  test('offers a settings link to create a cloud device when no project devices are available', async () => {
    const onOpenCloudDeviceSettings = vi.fn()

    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={[]}
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenCloudDeviceSettings={onOpenCloudDeviceSettings}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    expect(screen.getByText('暂无可用设备')).toBeInTheDocument()
    const settingsLink = screen.getByTestId('open-cloud-device-settings-link')

    expect(settingsLink).toHaveAttribute('href', '/settings')

    await userEvent.click(settingsLink)

    expect(onOpenCloudDeviceSettings).toHaveBeenCalledTimes(1)
  })

  test('hides OpenClaw devices from the project device selector', () => {
    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={[
          ...devices,
          {
            id: 3,
            device_id: 'openclaw-device',
            name: 'OpenClaw Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'openclaw',
          },
        ]}
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    expect(screen.getByTestId('project-device-select')).toHaveTextContent('Cloud Device')
    expect(screen.queryByText(/OpenClaw Device/)).not.toBeInTheDocument()
  })

  test('allows selecting an online old device and shows an upgrade action', async () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)
    const onGetProjectWorkspaceRoot = vi.fn().mockResolvedValue('/workspace/projects')

    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={[
          {
            id: 4,
            device_id: 'old-device',
            name: 'Old Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'claudecode',
            executor_version: '1.8.4',
            slot_used: 0,
          },
        ]}
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onUpgradeDevice={onUpgradeDevice}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    const deviceSelect = screen.getByTestId('project-device-select')
    const oldDeviceOption = within(deviceSelect).getByRole('option', {
      name: /Old Device.*需升级/,
    })

    expect(deviceSelect).toHaveValue('old-device')
    expect(oldDeviceOption).not.toBeDisabled()
    expect(screen.getByTestId('create-project-button')).toBeDisabled()
    expect(onGetProjectWorkspaceRoot).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-device-unavailable-old-device')).toHaveTextContent(
      '当前 v1.8.4，需要 1.8.5 或以上',
    )

    await userEvent.click(screen.getByTestId('upgrade-project-device-old-device'))

    expect(onUpgradeDevice).toHaveBeenCalledWith('old-device')
  })

  test('shows an upgrade prompt only for the selected old device', async () => {
    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={[
          ...devices,
          {
            id: 4,
            device_id: 'old-device',
            name: 'Old Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'claudecode',
            executor_version: '1.8.4',
            slot_used: 0,
          },
          {
            id: 5,
            device_id: 'second-old-device',
            name: 'Second Old Device',
            status: 'online',
            is_default: false,
            device_type: 'local',
            bind_shell: 'claudecode',
            executor_version: '1.8.4',
            slot_used: 0,
          },
        ]}
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    const deviceSelect = screen.getByTestId('project-device-select')
    const availableOption = within(deviceSelect).getByRole('option', {
      name: /Cloud Device.*在线/,
    })
    const unavailableOption = within(deviceSelect).getByRole('option', {
      name: /^Old Device.*需升级/,
    })

    expect(deviceSelect).toHaveValue('cloud-device')
    expect(availableOption).not.toBeDisabled()
    expect(unavailableOption).not.toBeDisabled()
    expect(screen.queryByTestId('project-device-unavailable-list')).not.toBeInTheDocument()

    await userEvent.selectOptions(deviceSelect, 'old-device')

    expect(deviceSelect).toHaveValue('old-device')
    expect(screen.getByTestId('project-device-unavailable-old-device')).toHaveTextContent(
      '当前 v1.8.4，需要 1.8.5 或以上',
    )
    expect(
      screen.queryByTestId('project-device-unavailable-second-old-device'),
    ).not.toBeInTheDocument()
  })

  test('does not load directories for a selected old device', () => {
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/user')
    const onListDeviceDirectories = vi.fn().mockResolvedValue([])

    render(
      <ProjectCreateDialog
        open
        mode="existing"
        devices={[
          {
            id: 4,
            device_id: 'old-device',
            name: 'Old Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'claudecode',
            executor_version: '1.8.4',
            slot_used: 0,
          },
        ]}
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    expect(screen.getByTestId('project-directory-path-input')).toBeDisabled()
    expect(screen.getByTestId('project-directory-device-unavailable')).toHaveTextContent(
      '升级当前设备后可选择目录',
    )
    expect(onGetDeviceHomeDirectory).not.toHaveBeenCalled()
    expect(onListDeviceDirectories).not.toHaveBeenCalled()
  })

  test('uses the preferred device and keeps form state when device preference changes', async () => {
    const onSelectDevicePreference = vi.fn()

    function Harness() {
      const [preferredDeviceId, setPreferredDeviceId] = useState('local-device')

      return (
        <ProjectCreateDialog
          open
          mode="scratch"
          devices={devices}
          preferredDeviceId={preferredDeviceId}
          onSelectDevicePreference={deviceId => {
            onSelectDevicePreference(deviceId)
            setPreferredDeviceId(deviceId)
          }}
          onClose={vi.fn()}
          onCreateProject={vi.fn()}
          onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
          onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
          onListDeviceDirectories={vi.fn().mockResolvedValue([])}
          onCreateDeviceDirectory={vi.fn()}
        />
      )
    }

    render(<Harness />)

    const deviceSelect = screen.getByTestId('project-device-select')
    const projectNameInput = screen.getByTestId('project-name-input')

    expect(deviceSelect).toHaveValue('local-device')

    await userEvent.type(projectNameInput, 'hello')
    await userEvent.selectOptions(deviceSelect, 'cloud-device')

    expect(onSelectDevicePreference).toHaveBeenCalledWith('cloud-device')
    expect(projectNameInput).toHaveValue('hello')
  })

  test('closes when Escape is pressed', () => {
    const onClose = vi.fn()

    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={devices}
        onClose={onClose}
        onCreateProject={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('keeps the dialog open and shows an error when project creation fails', async () => {
    const onClose = vi.fn()
    const onCreateProject = vi.fn().mockRejectedValue(new Error('create failed'))

    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={devices}
        preferredDeviceId="local-device"
        onClose={onClose}
        onCreateProject={onCreateProject}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    await userEvent.type(screen.getByTestId('project-name-input'), 'demo')
    await userEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() => expect(screen.getByTestId('project-create-error')).toHaveTextContent('create failed'))
    expect(onClose).not.toHaveBeenCalled()
  })

  test('filters parent directory entries when the path is typed partially', async () => {
    const onListDeviceDirectories = vi.fn((_: string, path: string) =>
      Promise.resolve(path === '/home/user/repo' ? ['src'] : ['Desktop', 'Downloads', 'repo']),
    )

    render(
      <ProjectCreateDialog
        open
        mode="existing"
        devices={devices}
        preferredDeviceId="local-device"
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    const pathInput = await screen.findByTestId('project-directory-path-input')
    await waitFor(() => expect(pathInput).toHaveValue('/home/user'))
    expect(await screen.findByText('repo')).toBeInTheDocument()

    await userEvent.clear(pathInput)
    await userEvent.type(pathInput, '/home/user/D')

    await waitFor(() => expect(screen.getByText('Desktop')).toBeInTheDocument())
    expect(screen.getByText('Downloads')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('repo')).not.toBeInTheDocument())
    expect(onListDeviceDirectories).not.toHaveBeenCalledWith('local-device', '/home/user/D')
  })

  test('opens the only fuzzy path match when Enter is pressed', async () => {
    const onListDeviceDirectories = vi.fn((_: string, path: string) =>
      Promise.resolve(path === '/home/user/repo' ? ['src'] : ['repo']),
    )

    render(
      <ProjectCreateDialog
        open
        mode="existing"
        devices={devices}
        preferredDeviceId="local-device"
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    const pathInput = await screen.findByTestId('project-directory-path-input')
    await waitFor(() => expect(pathInput).toHaveValue('/home/user'))

    await userEvent.clear(pathInput)
    await userEvent.type(pathInput, '/home/user/re')
    await waitFor(() => expect(pathInput).toHaveValue('/home/user/re'))
    fireEvent.keyDown(pathInput, { key: 'Enter' })

    await waitFor(() => expect(pathInput).toHaveValue('/home/user/repo'))
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('local-device', '/home/user/repo'),
    )
    expect(await screen.findByText('src')).toBeInTheDocument()
  })

  test('creates a folder and refreshes into the new directory', async () => {
    const onCreateDeviceDirectory = vi.fn().mockResolvedValue(undefined)
    const onListDeviceDirectories = vi.fn((_: string, path: string) =>
      Promise.resolve(path === '/home/user/new-app' ? ['src'] : []),
    )

    render(
      <ProjectCreateDialog
        open
        mode="existing"
        devices={devices}
        preferredDeviceId="local-device"
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
      />,
    )

    const pathInput = await screen.findByTestId('project-directory-path-input')
    await waitFor(() => expect(pathInput).toHaveValue('/home/user'))

    await userEvent.click(screen.getByTestId('open-create-folder-button'))
    await userEvent.type(screen.getByTestId('create-folder-name-input'), 'new-app')
    await userEvent.click(screen.getByTestId('confirm-create-folder-button'))

    await waitFor(() =>
      expect(onCreateDeviceDirectory).toHaveBeenCalledWith('local-device', '/home/user/new-app'),
    )
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('local-device', '/home/user/new-app'),
    )
    expect(pathInput).toHaveValue('/home/user/new-app')
    expect(await screen.findByText('src')).toBeInTheDocument()
  })

  test('creates a Git workspace project from selected repository and branch', async () => {
    const onCreateGitWorkspaceProject = vi.fn().mockResolvedValue({
      id: 9,
      name: 'Wegent',
      tasks: [],
    })
    const onClose = vi.fn()

    render(
      <ProjectCreateDialog
        open
        mode="git"
        devices={devices}
        preferredDeviceId="cloud-device"
        onClose={onClose}
        onCreateProject={vi.fn()}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
        onListGitRepositories={vi.fn().mockResolvedValue([
          ...repositories,
          {
            ...repositories[0],
            git_repo_id: 102,
            name: 'Docs',
            git_repo: 'wecode-ai/docs',
            git_url: 'https://github.com/wecode-ai/docs.git',
          },
        ])}
        onListGitBranches={vi.fn().mockResolvedValue(branches)}
      />,
    )

    await waitFor(() =>
      expect(screen.getByTestId('git-repository-select')).not.toBeDisabled(),
    )
    await userEvent.click(screen.getByTestId('git-repository-select'))
    await userEvent.type(
      screen.getByTestId('git-repository-select-search-input'),
      'Wegent',
    )
    const repositoryMenu = screen.getByTestId('git-repository-select-menu')
    expect(within(repositoryMenu).getByText('wecode-ai/Wegent')).toBeInTheDocument()
    expect(within(repositoryMenu).queryByText('wecode-ai/docs')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('git-repository-select-option'))
    await waitFor(() =>
      expect(screen.getByTestId('git-branch-select')).toHaveTextContent('main（默认）'),
    )
    await userEvent.click(screen.getByTestId('git-branch-select'))
    await userEvent.type(
      screen.getByTestId('git-branch-select-search-input'),
      'develop',
    )
    const branchMenu = screen.getByTestId('git-branch-select-menu')
    expect(within(branchMenu).getByText('develop')).toBeInTheDocument()
    expect(within(branchMenu).queryByText('main（默认）')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('git-branch-select-option'))
    await userEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() =>
      expect(onCreateGitWorkspaceProject).toHaveBeenCalledWith({
        device_id: 'cloud-device',
        name: 'Wegent',
        git: {
          url: 'https://github.com/wecode-ai/Wegent.git',
          repo: 'wecode-ai/Wegent',
          repoId: 101,
          domain: 'github.com',
          branch: 'develop',
        },
      }),
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('shows progress while Git workspace creation is running', async () => {
    let resolveCreate: ((project: { id: number; name: string; tasks: [] }) => void) | undefined
    const onCreateGitWorkspaceProject = vi.fn(
      () =>
        new Promise<ProjectWithTasks>(resolve => {
          resolveCreate = resolve
        }),
    )
    const onClose = vi.fn()

    render(
      <ProjectCreateDialog
        open
        mode="git"
        devices={devices}
        preferredDeviceId="cloud-device"
        onClose={onClose}
        onCreateProject={vi.fn()}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
        onListGitRepositories={vi.fn().mockResolvedValue(repositories)}
        onListGitBranches={vi.fn().mockResolvedValue(branches)}
      />,
    )

    await waitFor(() =>
      expect(screen.getByTestId('git-repository-select')).not.toBeDisabled(),
    )
    await userEvent.click(screen.getByTestId('git-repository-select'))
    await userEvent.click(screen.getAllByTestId('git-repository-select-option')[0])
    await waitFor(() =>
      expect(screen.getByTestId('git-branch-select')).toHaveTextContent('main（默认）'),
    )
    await userEvent.click(screen.getByTestId('create-project-button'))

    expect(screen.getByTestId('create-project-button')).toHaveTextContent('克隆中...')
    expect(screen.getByTestId('project-submit-spinner')).toBeInTheDocument()
    expect(screen.getByTestId('project-submit-progress')).toHaveTextContent(
      '正在克隆仓库，可能需要一点时间',
    )
    expect(screen.getByTestId('cancel-project-create-button')).toBeDisabled()

    resolveCreate?.({ id: 9, name: 'Wegent', tasks: [] })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
