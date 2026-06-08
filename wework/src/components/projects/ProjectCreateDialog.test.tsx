import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { DeviceInfo, GitBranch, GitRepoInfo, ProjectWithTasks } from '@/types/api'
import { ProjectCreateDialog } from './ProjectCreateDialog'

const devices: DeviceInfo[] = [
  {
    id: 1,
    device_id: 'cloud-device',
    name: 'Cloud Device',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
  },
  {
    id: 2,
    device_id: 'local-device',
    name: 'Local Device',
    status: 'online',
    is_default: false,
    device_type: 'local',
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
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />,
    )

    expect(screen.getByTestId('project-device-select')).toHaveTextContent('Cloud Device')
    expect(screen.queryByText(/OpenClaw Device/)).not.toBeInTheDocument()
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
    await userEvent.type(pathInput, '/home/user/re{Enter}')

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
        onListGitRepositories={vi.fn().mockResolvedValue(repositories)}
        onListGitBranches={vi.fn().mockResolvedValue(branches)}
      />,
    )

    await waitFor(() =>
      expect(screen.getByTestId('git-repository-select')).not.toBeDisabled(),
    )
    await userEvent.selectOptions(
      screen.getByTestId('git-repository-select'),
      'https://github.com/wecode-ai/Wegent.git',
    )
    await waitFor(() => expect(screen.getByTestId('git-branch-select')).toHaveValue('main'))
    await userEvent.selectOptions(screen.getByTestId('git-branch-select'), 'develop')
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
    await userEvent.selectOptions(
      screen.getByTestId('git-repository-select'),
      'https://github.com/wecode-ai/Wegent.git',
    )
    await waitFor(() => expect(screen.getByTestId('git-branch-select')).toHaveValue('main'))
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
