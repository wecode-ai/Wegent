import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'
import { createDeviceApi } from '@/api/devices'
import { copyTextToClipboard } from '@/lib/clipboard'
import { WEWORK_MIN_EXECUTOR_VERSION } from '@/lib/device-capabilities'
import '@/i18n'
import type { DeviceInfo } from '@/types/devices'
import { AddDevicePanel } from './AddDevicePanel'
import { AddCloudDeviceDialog } from '@/components/settings/AddCloudDeviceDialog'
import { StandaloneFolderProjectDialog } from '@/components/projects/StandaloneProjectDialogs'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { installGitUiTestContributions } from '../../../dsh/ui-git/test-support'

vi.mock('@/api/devices', () => ({ createDeviceApi: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn().mockResolvedValue(undefined) }))

const connection = {
  isConnected: true,
  apiBaseUrl: 'https://cloud.example/api',
  token: 'test-token',
}
const command = {
  device_id: 'new-remote',
  name: 'New remote',
  image: 'device:latest',
  env: {},
  command: 'docker run --network host -e DEVICE_ID=new-remote device:latest',
  commands: [{ kind: 'process', label: 'Host', command: 'local_executor_install.sh' }],
}
function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 2,
    device_id: 'new-remote',
    name: 'New remote',
    status: 'online',
    device_type: 'remote',
    is_default: false,
    bind_shell: 'claudecode',
    executor_version: WEWORK_MIN_EXECUTOR_VERSION,
    ...overrides,
  }
}
const api = {
  createCloudDevice: vi.fn(),
  createDockerRemoteDeviceCommand: vi.fn(),
  getAllDevices: vi.fn(),
}
const onConnected = vi.fn()
const getHome = vi.fn(async (deviceId: string) => `/home/${deviceId}`)
const listDirectories = vi.fn().mockResolvedValue([])
const openWorkspace = vi.fn().mockResolvedValue(undefined)

function ConnectedProject({
  devices = [],
  accountId = 1,
  onCloneGitRepository,
}: {
  devices?: DeviceInfo[]
  accountId?: number
  onCloneGitRepository?: React.ComponentProps<
    typeof StandaloneFolderProjectDialog
  >['onCloneGitRepository']
}) {
  const context = useOptionalCloudConnection()
  return (
    <CloudConnectionContext.Provider
      value={{
        ...context,
        ...connection,
        user: { id: accountId, user_name: 'test-user', email: '' },
      }}
    >
      <StandaloneFolderProjectDialog
        open
        mode="remote"
        devices={devices}
        onClose={vi.fn()}
        onGetDeviceHomeDirectory={getHome}
        onListDeviceDirectories={listDirectories}
        onCreateDeviceDirectory={vi.fn()}
        onCloneGitRepository={onCloneGitRepository}
        onOpenStandaloneWorkspace={openWorkspace}
      />
    </CloudConnectionContext.Provider>
  )
}

describe('shared device onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createDeviceApi).mockReturnValue(api as unknown as ReturnType<typeof createDeviceApi>)
    api.createDockerRemoteDeviceCommand.mockResolvedValue(command)
    api.getAllDevices.mockResolvedValue([])
    api.createCloudDevice.mockResolvedValue({ id: 3, device_id: 'new-cloud' })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test.each(['settings', 'project'] as const)(
    '%s opens the same two choices without generating a command',
    entry => {
      if (entry === 'settings')
        render(
          <AddCloudDeviceDialog
            open
            cloudConnection={connection}
            onClose={vi.fn()}
            onCreated={vi.fn()}
          />
        )
      else render(<ConnectedProject />)
      expect(screen.getByTestId('add-device-panel')).toHaveTextContent('云设备')
      expect(screen.getByTestId('add-device-panel')).toHaveTextContent('远程 Docker 设备')
      expect(screen.getByTestId('add-cloud-device-confirm')).toBeEnabled()
      expect(screen.getByTestId('add-remote-docker-button')).toBeEnabled()
      expect(screen.queryByText('宿主机启动')).not.toBeInTheDocument()
      expect(api.createDockerRemoteDeviceCommand).not.toHaveBeenCalled()
      expect(api.createCloudDevice).not.toHaveBeenCalled()
      expect(api.getAllDevices).not.toHaveBeenCalled()
    }
  )

  test('generates and copies only the Docker command', async () => {
    render(<AddDevicePanel cloudConnection={connection} onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    expect(await screen.findByTestId('remote-docker-command')).toHaveTextContent(command.command)
    expect(screen.queryByText('local_executor_install.sh')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('copy-remote-docker-command'))
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(command.command))
  })

  test('retains a generation error and allows a deliberate retry', async () => {
    api.createDockerRemoteDeviceCommand.mockRejectedValueOnce(new Error('Generation unavailable'))
    render(<AddDevicePanel cloudConnection={connection} onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Generation unavailable')
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    expect(await screen.findByTestId('remote-docker-command')).toBeInTheDocument()
    expect(api.createDockerRemoteDeviceCommand).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('switching to managed creation cancels the previous Docker connection attempt', async () => {
    let resolve!: (devices: DeviceInfo[]) => void
    api.getAllDevices.mockImplementationOnce(
      () =>
        new Promise<DeviceInfo[]>(done => {
          resolve = done
        })
    )
    render(<AddDevicePanel cloudConnection={connection} onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    await screen.findByTestId('remote-docker-command')
    await waitFor(() => expect(api.getAllDevices).toHaveBeenCalledTimes(1))
    const signal = api.getAllDevices.mock.calls[0][0].signal as AbortSignal
    fireEvent.click(screen.getByTestId('add-cloud-device-confirm'))
    await waitFor(() => expect(api.createCloudDevice).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('remote-docker-command')).not.toBeInTheDocument()
    expect(signal.aborted).toBe(true)
    await act(async () => {
      resolve([device()])
    })
    expect(onConnected).not.toHaveBeenCalled()
  })

  test('keeps adding a device while an unrelated usable device appears during generation', async () => {
    let resolve!: (value: typeof command) => void
    api.createDockerRemoteDeviceCommand.mockReturnValue(
      new Promise<typeof command>(done => {
        resolve = done
      })
    )
    const view = render(<ConnectedProject />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    view.rerender(<ConnectedProject devices={[device({ device_id: 'unrelated' })]} />)
    expect(screen.getByTestId('add-device-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('remote-project-source-existing')).not.toBeInTheDocument()
    await act(async () => {
      resolve(command)
    })
    expect(screen.getByTestId('remote-docker-command')).toHaveTextContent(command.command)
  })

  test('does not complete for another online device or the target while offline', async () => {
    api.getAllDevices.mockResolvedValue([
      device({ device_id: 'existing' }),
      device({ status: 'offline' }),
    ])
    render(<AddDevicePanel cloudConnection={connection} onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    await waitFor(() =>
      expect(screen.getByTestId('device-onboarding-status')).toHaveTextContent('连接中')
    )
    expect(onConnected).not.toHaveBeenCalled()
  })

  test.each(['dev', '1.0.0', null])(
    'keeps incompatible version %s visible and connects after refresh',
    async version => {
      api.getAllDevices.mockResolvedValue([device({ executor_version: version })])
      render(<AddDevicePanel cloudConnection={connection} onConnected={onConnected} />)
      fireEvent.click(screen.getByTestId('add-remote-docker-button'))
      await waitFor(() =>
        expect(screen.getByTestId('device-onboarding-status')).toHaveTextContent('版本不匹配')
      )
      expect(onConnected).not.toHaveBeenCalled()
      api.getAllDevices.mockResolvedValue([device()])
      fireEvent.click(screen.getByTestId('retry-device-onboarding'))
      await waitFor(() => expect(onConnected).toHaveBeenCalledWith([device()], device()))
      expect(api.createDockerRemoteDeviceCommand).toHaveBeenCalledTimes(1)
    }
  )

  test('shows connection failure after the polling budget and can refresh the same device', async () => {
    vi.useFakeTimers()
    render(<AddDevicePanel cloudConnection={connection} onConnected={onConnected} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000)
    })
    expect(screen.getByTestId('device-onboarding-status')).toHaveTextContent('连接失败')
    api.getAllDevices.mockResolvedValue([device()])
    await act(async () => {
      fireEvent.click(screen.getByTestId('retry-device-onboarding'))
    })
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(api.createDockerRemoteDeviceCommand).toHaveBeenCalledTimes(1)
  })

  test('allows only one managed creation and waits for its actual device', async () => {
    const onCreated = vi.fn()
    render(
      <AddDevicePanel
        cloudConnection={connection}
        onCreated={onCreated}
        onConnected={onConnected}
      />
    )
    fireEvent.click(screen.getByTestId('add-cloud-device-confirm'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(undefined, 3))
    expect(screen.getByTestId('add-cloud-device-confirm')).toBeDisabled()
    expect(onConnected).not.toHaveBeenCalled()
    expect(api.createCloudDevice).toHaveBeenCalledTimes(1)
  })

  test('continues on the created cloud record when provisioning changes its device identity', async () => {
    api.createCloudDevice.mockResolvedValue({ id: 3, device_id: 'provisioning-device' })
    api.getAllDevices.mockResolvedValue([
      device({ id: 3, device_id: 'new-cloud', device_type: 'cloud' }),
    ])
    render(<ConnectedProject />)
    fireEvent.click(screen.getByTestId('add-cloud-device-confirm'))
    expect(await screen.findByTestId('standalone-remote-device-select')).toHaveValue('new-cloud')
    expect(screen.getByTestId('remote-project-source-existing')).toBeInTheDocument()
    expect(screen.queryByTestId('add-device-panel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('remote-project-source-existing'))
    expect(await screen.findByTestId('device-folder-path-input')).toBeInTheDocument()
  })

  test('continues remote project creation on the generated Docker device', async () => {
    api.getAllDevices.mockResolvedValue([device()])
    render(<ConnectedProject />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    expect(await screen.findByTestId('standalone-remote-device-select')).toHaveValue('new-remote')
    expect(screen.getByTestId('remote-project-source-blank')).toBeInTheDocument()
  })

  test('blocks another cloud device while keeping remote Docker available', () => {
    render(<ConnectedProject devices={[device({ device_type: 'cloud', status: 'offline' })]} />)
    expect(screen.getByTestId('add-cloud-device-confirm')).toBeDisabled()
    expect(screen.getByTestId('add-remote-docker-button')).toBeEnabled()
  })

  test('can add a device from an existing project picker and select the new target', async () => {
    api.getAllDevices.mockResolvedValue([device()])
    render(<ConnectedProject devices={[device({ device_id: 'existing' })]} />)
    expect(screen.getByTestId('standalone-remote-device-select')).toHaveValue('existing')
    fireEvent.click(screen.getByTestId('remote-project-add-device'))
    expect(screen.getByTestId('add-device-panel')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    await waitFor(() =>
      expect(screen.getByTestId('standalone-remote-device-select')).toHaveValue('new-remote')
    )
  })

  test('can return to the existing project picker without creating a device', () => {
    render(<ConnectedProject devices={[device()]} />)
    fireEvent.click(screen.getByTestId('remote-project-add-device'))
    fireEvent.click(screen.getByTestId('remote-project-cancel-add-device'))
    expect(screen.getByTestId('standalone-remote-device-select')).toHaveValue('new-remote')
    expect(api.createDockerRemoteDeviceCommand).not.toHaveBeenCalled()
  })

  test('keeps an accepted cloud creation disabled after returning to project selection', async () => {
    render(<ConnectedProject devices={[device()]} />)
    fireEvent.click(screen.getByTestId('remote-project-add-device'))
    fireEvent.click(screen.getByTestId('add-cloud-device-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('remote-project-cancel-add-device')).toBeEnabled()
    )
    fireEvent.click(screen.getByTestId('remote-project-cancel-add-device'))
    fireEvent.click(screen.getByTestId('remote-project-add-device'))
    expect(screen.getByTestId('add-cloud-device-confirm')).toBeDisabled()
    expect(screen.getByTestId('add-remote-docker-button')).toBeEnabled()
    expect(api.createCloudDevice).toHaveBeenCalledTimes(1)
  })

  test('uses the connected state even if the parent still has an offline copy of the same device', async () => {
    api.getAllDevices.mockResolvedValue([device()])
    render(<ConnectedProject devices={[device({ status: 'offline' })]} />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    await waitFor(() =>
      expect(screen.getByTestId('standalone-remote-device-select')).toHaveValue('new-remote')
    )
    expect(screen.getByTestId('standalone-remote-device-option-new-remote')).toBeEnabled()
  })

  test('uses the published catalog after discovery, including offline and deleted devices', async () => {
    const original = device({ device_id: 'existing', status: 'offline' })
    api.getAllDevices.mockResolvedValue([{ ...original, status: 'online' }, device()])
    const view = render(<ConnectedProject devices={[original]} />)

    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    const select = await screen.findByTestId('standalone-remote-device-select')
    await waitFor(() => expect(select).toHaveValue('new-remote'))
    expect(screen.getByTestId('standalone-remote-device-option-existing')).toBeDisabled()

    view.rerender(<ConnectedProject devices={[original, device()]} />)
    expect(select).toHaveValue('new-remote')

    view.rerender(<ConnectedProject devices={[original, device({ status: 'offline' })]} />)
    expect(select).toHaveValue('')
    expect(screen.getByTestId('standalone-remote-device-option-new-remote')).toBeDisabled()
    expect(screen.queryByTestId('remote-project-source-existing')).not.toBeInTheDocument()

    view.rerender(<ConnectedProject devices={[]} />)
    expect(
      screen.queryByTestId('standalone-remote-device-option-new-remote')
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('standalone-remote-device-select')).not.toBeInTheDocument()
  })

  test('resets the Git directory and folder picker when a new device is selected', async () => {
    await installGitUiTestContributions()
    const original = device({ device_id: 'existing' })
    const onCloneGitRepository = vi.fn().mockResolvedValue(undefined)
    api.getAllDevices.mockResolvedValue([original, device()])
    render(<ConnectedProject devices={[original]} onCloneGitRepository={onCloneGitRepository} />)

    fireEvent.click(screen.getByTestId('remote-project-source-git'))
    const parent = screen.getByTestId('remote-project-git-parent-input')
    await waitFor(() => expect(parent).toHaveValue('/home/existing'))
    const url = 'https://example.com/team/repository.git'
    fireEvent.change(screen.getByTestId('remote-project-git-url-input'), { target: { value: url } })
    fireEvent.change(parent, { target: { value: '/old-device/projects' } })
    fireEvent.click(screen.getByTestId('remote-project-git-parent-browse'))
    expect(await screen.findByTestId('device-folder-path-input')).toHaveValue(
      '/old-device/projects'
    )

    fireEvent.click(screen.getByTestId('remote-project-add-device'))
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))

    await waitFor(() =>
      expect(screen.getByTestId('standalone-remote-device-select')).toHaveValue('new-remote')
    )
    expect(screen.queryByTestId('device-folder-path-input')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/home/new-remote')
    )
    expect(screen.getByTestId('remote-project-git-url-input')).toHaveValue(url)
    fireEvent.click(screen.getByTestId('remote-project-git-submit'))
    await waitFor(() =>
      expect(onCloneGitRepository).toHaveBeenCalledWith('new-remote', {
        url,
        targetPath: '/home/new-remote/repository',
      })
    )
    await waitFor(() =>
      expect(openWorkspace).toHaveBeenCalledWith(
        'new-remote',
        '/home/new-remote/repository',
        'repository'
      )
    )
  })

  test('settings closes and publishes only the connected target', async () => {
    const onClose = vi.fn()
    const onCreated = vi.fn()
    api.getAllDevices.mockResolvedValue([device()])
    render(
      <AddCloudDeviceDialog
        open
        cloudConnection={connection}
        onClose={onClose}
        onCreated={onCreated}
      />
    )
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith([device()], device().id))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('settings retains the managed creation notification contract', async () => {
    const onClose = vi.fn()
    const onCreated = vi.fn()
    const onCreatingChange = vi.fn()
    render(
      <AddCloudDeviceDialog
        open
        cloudConnection={connection}
        onClose={onClose}
        onCreated={onCreated}
        onCreatingChange={onCreatingChange}
      />
    )
    fireEvent.click(screen.getByTestId('add-cloud-device-confirm'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onCreated).toHaveBeenCalledWith(undefined, 3)
    expect(onCreatingChange).toHaveBeenCalledWith(true)
  })

  test('shows a copy failure without claiming that the command was copied', async () => {
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error('Clipboard unavailable'))
    render(<AddDevicePanel cloudConnection={connection} onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    await screen.findByTestId('remote-docker-command')
    fireEvent.click(screen.getByTestId('copy-remote-docker-command'))
    expect(await screen.findByRole('alert')).toHaveTextContent('复制 Docker 命令失败')
    expect(screen.getByTestId('copy-remote-docker-command')).not.toHaveTextContent('已复制')
    fireEvent.click(screen.getByTestId('copy-remote-docker-command'))
    await waitFor(() =>
      expect(screen.getByTestId('copy-remote-docker-command')).toHaveTextContent('已复制')
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('disables both mutations without a cloud connection', () => {
    render(
      <AddDevicePanel
        cloudConnection={{ ...connection, isConnected: false, token: null }}
        onConnected={onConnected}
      />
    )
    expect(screen.getByTestId('add-cloud-device-confirm')).toBeDisabled()
    expect(screen.getByTestId('add-remote-docker-button')).toBeDisabled()
  })

  test('aborts a pending poll on unmount and ignores its late device', async () => {
    let resolve!: (devices: DeviceInfo[]) => void
    api.getAllDevices.mockReturnValue(
      new Promise<DeviceInfo[]>(done => {
        resolve = done
      })
    )
    const view = render(<AddDevicePanel cloudConnection={connection} onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    await waitFor(() => expect(api.getAllDevices).toHaveBeenCalledTimes(1))
    const signal = api.getAllDevices.mock.calls[0][0].signal as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => {
      resolve([device()])
    })
    expect(onConnected).not.toHaveBeenCalled()
  })

  test('discards command and late results after the connection scope changes', async () => {
    let resolve!: (value: typeof command) => void
    api.createDockerRemoteDeviceCommand.mockReturnValue(
      new Promise<typeof command>(done => {
        resolve = done
      })
    )
    const view = render(<AddDevicePanel cloudConnection={connection} onConnected={onConnected} />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    view.rerender(
      <AddDevicePanel
        cloudConnection={{ ...connection, token: 'another-account' }}
        onConnected={onConnected}
      />
    )
    await act(async () => {
      resolve(command)
    })
    expect(screen.queryByTestId('remote-docker-command')).not.toBeInTheDocument()
    expect(api.getAllDevices).not.toHaveBeenCalled()
    expect(onConnected).not.toHaveBeenCalled()
  })

  test('discards discovered project devices when the connected account changes', async () => {
    api.getAllDevices.mockResolvedValue([device()])
    const view = render(<ConnectedProject />)
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    expect(await screen.findByTestId('standalone-remote-device-select')).toHaveValue('new-remote')
    view.rerender(<ConnectedProject accountId={2} />)
    expect(screen.getByTestId('add-device-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('standalone-remote-device-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('remote-docker-command')).not.toBeInTheDocument()
  })

  test('preserves a generated command when the same account refreshes its token', async () => {
    const cloudConnection = { ...connection, user: { id: 7 } }
    const view = render(
      <AddDevicePanel cloudConnection={cloudConnection} onConnected={onConnected} />
    )
    fireEvent.click(screen.getByTestId('add-remote-docker-button'))
    await screen.findByTestId('remote-docker-command')
    view.rerender(
      <AddDevicePanel
        cloudConnection={{ ...cloudConnection, token: 'refreshed-token' }}
        onConnected={onConnected}
      />
    )
    expect(screen.getByTestId('remote-docker-command')).toHaveTextContent(command.command)
    expect(api.createDockerRemoteDeviceCommand).toHaveBeenCalledTimes(1)
  })
})
