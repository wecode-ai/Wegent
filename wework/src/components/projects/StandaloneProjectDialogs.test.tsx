import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { DeviceInfo } from '@/types/api'
import { WEWORK_MIN_EXECUTOR_VERSION } from '@/lib/device-capabilities'
import { StandaloneFolderProjectDialog } from './StandaloneProjectDialogs'
import '@/i18n'

vi.mock('@/features/dsh-runtime/useDshSlotAvailable', () => ({
  useDshSlotAvailable: () => true,
}))
vi.mock('./StandaloneGitProjectForm', () => ({
  StandaloneGitProjectForm: ({ device }: { device: DeviceInfo | null }) => (
    <div>
      <div data-testid="git-target">{device?.device_id ?? 'none'}</div>
      <input data-testid="fixture-git-url" defaultValue="" />
    </div>
  ),
}))
vi.mock('@/components/devices/AddDevicePanel', () => ({
  AddDevicePanel: ({
    onConnected,
  }: {
    onConnected: (devices: DeviceInfo[], device: DeviceInfo) => Promise<void>
  }) => (
    <button
      data-testid="fixture-connect-device"
      onClick={() =>
        void onConnected([], { ...device, id: 2, device_id: 'new-device', name: 'New device' })
      }
    >
      Connect
    </button>
  ),
}))

const device = {
  id: 1,
  device_id: 'late-device',
  name: 'Late device',
  device_type: 'remote',
  bind_shell: 'claudecode',
  status: 'online',
  executor_version: WEWORK_MIN_EXECUTOR_VERSION,
} as DeviceInfo

function props(): ComponentProps<typeof StandaloneFolderProjectDialog> {
  return {
    open: true,
    mode: 'remote',
    devices: [],
    onClose: vi.fn(),
    onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/home'),
    onListDeviceDirectories: vi.fn().mockResolvedValue([]),
    onCreateDeviceDirectory: vi.fn().mockResolvedValue(undefined),
  }
}

describe('standalone project device identity', () => {
  it.each([false, true])(
    'retains the asynchronously discovered device when entering Git (fixed=%s)',
    async fixed => {
      const input = { ...props(), ...(fixed ? { fixedDeviceId: device.device_id } : {}) }
      const { rerender } = render(<StandaloneFolderProjectDialog {...input} />)
      expect(screen.queryByTestId('remote-project-source-git')).not.toBeInTheDocument()
      rerender(<StandaloneFolderProjectDialog {...input} devices={[device]} />)
      fireEvent.click(await screen.findByTestId('remote-project-source-git'))
      expect(screen.getByTestId('git-target')).toHaveTextContent('late-device')
      expect(Boolean(screen.queryByTestId('standalone-remote-device-select'))).toBe(!fixed)
    }
  )

  it('selects the preferred late device instead of silently choosing the first', async () => {
    const input = { ...props(), preferredDeviceId: 'preferred' }
    const preferred = { ...device, id: 2, device_id: 'preferred', name: 'Preferred' }
    const { rerender } = render(<StandaloneFolderProjectDialog {...input} />)
    rerender(<StandaloneFolderProjectDialog {...input} devices={[device, preferred]} />)
    await waitFor(() =>
      expect(screen.getByTestId('standalone-remote-device-select')).toHaveValue('preferred')
    )
    fireEvent.click(screen.getByTestId('remote-project-source-git'))
    expect(screen.getByTestId('git-target')).toHaveTextContent('preferred')
  })

  it('requires explicit replacement after the selected device is removed', async () => {
    const replacement = { ...device, id: 2, device_id: 'replacement', name: 'Replacement' }
    const input = { ...props(), devices: [device, replacement] }
    const { rerender } = render(<StandaloneFolderProjectDialog {...input} />)
    fireEvent.click(screen.getByTestId('remote-project-source-git'))
    expect(screen.getByTestId('git-target')).toHaveTextContent('late-device')
    rerender(<StandaloneFolderProjectDialog {...input} devices={[replacement]} />)
    expect(screen.getByTestId('git-target')).toHaveTextContent('none')
    expect(screen.getByTestId('standalone-remote-device-select')).toHaveValue('')
    fireEvent.change(screen.getByTestId('standalone-remote-device-select'), {
      target: { value: 'replacement' },
    })
    expect(screen.getByTestId('git-target')).toHaveTextContent('replacement')
  })

  it('retains the Git form while adding a device and binds the discovered device', async () => {
    const input = { ...props(), devices: [device], onRefreshDevices: vi.fn() }
    render(<StandaloneFolderProjectDialog {...input} />)
    fireEvent.click(screen.getByTestId('remote-project-source-git'))
    const urlInput = screen.getByTestId('fixture-git-url')
    fireEvent.change(urlInput, { target: { value: 'https://git.example.test/team/repo.git' } })

    fireEvent.click(screen.getByTestId('remote-project-add-device'))
    expect(urlInput).not.toBeVisible()
    fireEvent.click(screen.getByTestId('remote-project-cancel-add-device'))
    expect(screen.getByTestId('fixture-git-url')).toBe(urlInput)
    expect(urlInput).toBeVisible()

    fireEvent.click(screen.getByTestId('remote-project-add-device'))
    fireEvent.click(screen.getByTestId('fixture-connect-device'))
    await waitFor(() => expect(screen.getByTestId('git-target')).toHaveTextContent('new-device'))
    expect(screen.getByTestId('fixture-git-url')).toBe(urlInput)
    expect(urlInput).toHaveValue('https://git.example.test/team/repo.git')
    expect(screen.getByTestId('standalone-remote-device-select')).toHaveValue('new-device')
    expect(input.onRefreshDevices).toHaveBeenCalledOnce()
  })

  it('selects the current device when reopening after the previous device was removed', () => {
    const input = { ...props(), devices: [device] }
    const { rerender } = render(<StandaloneFolderProjectDialog {...input} />)
    fireEvent.click(screen.getByTestId('remote-project-source-git'))
    rerender(<StandaloneFolderProjectDialog {...input} open={false} />)
    const replacement = { ...device, id: 2, device_id: 'replacement', name: 'Replacement' }
    rerender(<StandaloneFolderProjectDialog {...input} devices={[replacement]} />)
    fireEvent.click(screen.getByTestId('remote-project-source-git'))
    expect(screen.getByTestId('git-target')).toHaveTextContent('replacement')
  })
})
