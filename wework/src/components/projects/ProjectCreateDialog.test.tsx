import '@/i18n'
import type { DeviceInfo, DeviceWorkspaceResponse } from '@/types/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ProjectCreateDialog } from './ProjectCreateDialog'

const pickerMocks = vi.hoisted(() => ({
  openNative: vi.fn(),
  useNative: false,
}))

vi.mock('@/e2e/automation', () => ({
  shouldUseNativeProjectDirectoryPicker: () => pickerMocks.useNative,
}))

vi.mock('@/lib/native-directory-picker', () => ({
  openNativeProjectDirectoryPicker: pickerMocks.openNative,
}))

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

function mapping(overrides: Partial<DeviceWorkspaceResponse> = {}): DeviceWorkspaceResponse {
  return {
    id: 10,
    userId: 1,
    projectId: 7,
    deviceId: 'local-device',
    workspacePath: '/home/user/Wegent',
    repoUrl: null,
    repoRootFingerprint: null,
    label: null,
    createdAt: '2026-06-21T00:00:00',
    updatedAt: '2026-06-21T00:00:00',
    lastSeenAt: null,
    ...overrides,
  }
}

describe('ProjectCreateDialog', () => {
  beforeEach(() => {
    pickerMocks.openNative.mockReset()
    pickerMocks.useNative = false
  })

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
      />
    )

    const settingsLink = screen.getByTestId('open-cloud-device-settings-link')

    expect(settingsLink).toHaveAttribute('href', '/settings/connections')

    await userEvent.click(settingsLink)

    expect(onOpenCloudDeviceSettings).toHaveBeenCalledTimes(1)
  })

  test('create flow shows all device tabs and starts on the preferred device', () => {
    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={devices}
        preferredDeviceId="local-device"
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onPrepareDeviceWorkspace={vi.fn()}
        onDeleteDeviceWorkspace={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />
    )

    expect(screen.getByTestId('project-device-tab-local-device')).toHaveTextContent('Local Device')
    expect(screen.getByTestId('project-device-tab-local-device')).toHaveClass('bg-text-primary')
    expect(screen.getByTestId('project-device-tab-cloud-device')).toHaveTextContent('Cloud Device')
    expect(screen.queryByTestId('project-add-other-device-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('create-project-button')).toBeDisabled()
  })

  test('create flow disables unavailable device tabs and starts on an available device', async () => {
    const offlineDevices: DeviceInfo[] = [
      {
        ...devices[1],
        name: 'Offline Local',
        status: 'offline',
      },
      devices[0],
    ]

    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={offlineDevices}
        preferredDeviceId="local-device"
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onPrepareDeviceWorkspace={vi.fn()}
        onDeleteDeviceWorkspace={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />
    )

    const offlineTab = screen.getByTestId('project-device-tab-local-device')

    expect(screen.getByTestId('project-device-tab-cloud-device')).toHaveClass('bg-text-primary')
    expect(offlineTab).toBeDisabled()
    expect(offlineTab).toHaveTextContent('离线')

    await userEvent.click(offlineTab)

    expect(screen.getByTestId('project-device-tab-cloud-device')).toHaveClass('bg-text-primary')
  })

  test('creates a project from the selected current-device folder name', async () => {
    const onCreateProject = vi.fn().mockResolvedValue({ id: 2, name: 'repo', tasks: [] })
    const onPrepareDeviceWorkspace = vi.fn().mockResolvedValue({
      preparedAction: 'selected',
      mapping: mapping({
        id: 10,
        projectId: 2,
        deviceId: 'local-device',
        workspacePath: '/home/user/repo',
      }),
    })

    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={devices}
        preferredDeviceId="local-device"
        onClose={vi.fn()}
        onCreateProject={onCreateProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onDeleteDeviceWorkspace={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue(['repo'])}
        onCreateDeviceDirectory={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('project-folder-select-button'))
    await userEvent.click(await screen.findByText('repo'))
    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))

    expect(screen.getByTestId('project-name-preview')).toHaveTextContent('repo')
    await userEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith(
        {
          name: 'repo',
          description: '',
          config: { mode: 'workspace' },
        },
        { refreshWorkLists: false }
      )
    )
    expect(onPrepareDeviceWorkspace).toHaveBeenCalledWith(
      {
        projectId: 2,
        deviceId: 'local-device',
        workspacePath: '/home/user/repo',
        action: 'select',
      },
      { refreshWorkLists: false }
    )
  })

  test('unlinking a mapped device calls deleteDeviceWorkspace on save', async () => {
    const onDeleteDeviceWorkspace = vi.fn().mockResolvedValue(undefined)

    render(
      <ProjectCreateDialog
        open
        mode="existing"
        project={{ id: 7, name: 'Wegent', tasks: [] }}
        devices={devices}
        deviceWorkspaces={[mapping()]}
        onClose={vi.fn()}
        onCreateProject={vi.fn()}
        onPrepareDeviceWorkspace={vi.fn()}
        onDeleteDeviceWorkspace={onDeleteDeviceWorkspace}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('project-device-unlink-button'))
    await userEvent.click(screen.getByTestId('create-project-button'))

    expect(onDeleteDeviceWorkspace).toHaveBeenCalledWith({
      projectId: 7,
      deviceId: 'local-device',
      workspacePath: '/home/user/Wegent',
    })
  })
})
