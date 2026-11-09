import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { StandaloneGitProjectForm } from './StandaloneGitProjectForm'
import type { DeviceInfo } from '@/types/api'
import '@/i18n'

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  summary: vi.fn(),
  sync: vi.fn(),
  cloud: {
    isConnected: true,
    backendUrl: 'https://cloud.example',
    webUrl: 'https://web.example/wegent',
    user: { id: 1 },
  },
}))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => mocks.cloud,
}))
vi.mock('@/components/settings/settings-cloud-api', () => ({
  createSettingsDeviceApi: () => ({
    getGitAccountSyncSummary: mocks.summary,
    syncGitAccounts: mocks.sync,
  }),
}))
vi.mock('@/lib/external-links', () => ({ openExternalUrl: mocks.openUrl }))

const device = {
  device_id: 'original-device',
  name: 'Original device',
  device_type: 'remote',
  bind_shell: 'claudecode',
  status: 'online',
} as DeviceInfo
const url = 'https://git.example:8443/owner/repository.git'
const errorFor = (code: string) =>
  new Error(
    `git-access:${JSON.stringify({
      code,
      domain: 'git.example:8443',
      message: 'Repository access failed',
    })}`
  )

function renderForm(clone = vi.fn().mockResolvedValue(undefined), targetDevice = device) {
  const close = vi.fn()
  const open = vi.fn().mockResolvedValue(undefined)
  const home = vi.fn().mockResolvedValue('/original')
  const props = {
    device: targetDevice,
    onGetDeviceHomeDirectory: home,
    onListDeviceDirectories: vi.fn().mockResolvedValue([]),
    onCreateDeviceDirectory: vi.fn(),
    onCloneGitRepository: clone,
    onOpenStandaloneWorkspace: open,
    onClose: close,
    onSubmittingChange: vi.fn(),
  }
  return { ...render(<StandaloneGitProjectForm {...props} />), close, open, home, props }
}

async function fillForm() {
  await waitFor(() =>
    expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/original')
  )
  fireEvent.change(screen.getByTestId('remote-project-git-url-input'), { target: { value: url } })
  await userEvent.click(screen.getByTestId('remote-project-git-advanced-toggle'))
  fireEvent.change(screen.getByTestId('remote-project-git-branch-input'), {
    target: { value: 'develop' },
  })
}

describe('Remote project Git configuration', () => {
  beforeEach(() => {
    mocks.cloud.isConnected = true
    mocks.cloud.webUrl = 'https://web.example/wegent'
    mocks.cloud.user = { id: 1 }
    mocks.summary.mockReset().mockResolvedValue({ accounts: [], effective_count: 0 })
    mocks.sync.mockReset().mockResolvedValue(undefined)
    mocks.openUrl.mockReset().mockResolvedValue(true)
  })

  test('places a text configuration action beside the URL label without a permanent hint', () => {
    renderForm()
    const heading = screen.getByTestId('remote-project-git-url-heading')
    const action = screen.getByTestId('remote-project-git-configure')
    const input = screen.getByTestId('remote-project-git-url-input')
    expect(heading).toContainElement(action)
    expect(heading).toContainElement(screen.getByText('Git 仓库地址', { selector: 'label' }))
    expect(screen.getByLabelText('Git 仓库地址')).toBe(input)
    expect(action.closest('label')).toBeNull()
    expect(action).toHaveClass('border-0', 'bg-transparent', 'px-0', 'font-normal')
    expect(action).not.toHaveClass('border', 'bg-base')
    expect(screen.queryByText('私有仓库需要目标设备上的 Git 凭据。')).not.toBeInTheDocument()
    expect(screen.queryByTestId('remote-project-git-error')).not.toBeInTheDocument()
  })

  test('offers quiet exact-domain configuration in the form before submitting', async () => {
    const { close } = renderForm()
    await fillForm()
    const button = screen.getByTestId('remote-project-git-configure')
    expect(button).not.toHaveClass('bg-text-primary')
    expect(button.querySelector('svg')).toBeNull()
    await userEvent.click(button)
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith(
      'https://web.example/wegent/settings?tab=integrations&gitDomain=git.example%3A8443#git-accounts',
      { source: 'git-clone-recovery' }
    )
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByTestId('remote-project-git-url-input')).toHaveValue(url)
  })

  test('an SSH URL does not offer cloud token configuration', async () => {
    renderForm()
    await fillForm()
    fireEvent.change(screen.getByTestId('remote-project-git-url-input'), {
      target: { value: 'git@git.example:owner/repository.git' },
    })
    expect(screen.queryByTestId('remote-project-git-configure')).not.toBeInTheDocument()
  })

  test('waits for restored Web metadata instead of opening Backend settings', async () => {
    mocks.cloud.webUrl = ''
    const { rerender, props } = renderForm()
    await fillForm()
    expect(screen.queryByTestId('remote-project-git-configure')).not.toBeInTheDocument()
    expect(mocks.openUrl).not.toHaveBeenCalled()

    mocks.cloud.webUrl = 'https://restored-web.example/wegent'
    rerender(<StandaloneGitProjectForm {...props} />)
    await userEvent.click(screen.getByTestId('remote-project-git-configure'))
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith(
      'https://restored-web.example/wegent/settings?tab=integrations&gitDomain=git.example%3A8443#git-accounts',
      { source: 'git-clone-recovery' }
    )
    expect(screen.getByTestId('remote-project-git-url-input')).toHaveValue(url)
  })

  test('retains inputs after missing credentials and resumes the same device, branch and path', async () => {
    const clone = vi
      .fn()
      .mockRejectedValueOnce(errorFor('credentials-required'))
      .mockResolvedValue(undefined)
    const { close, open } = renderForm(clone)
    await fillForm()
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    expect(await screen.findByTestId('remote-project-git-error')).toHaveTextContent(
      'git.example:8443'
    )
    expect(close).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByTestId('remote-project-git-url-input')).toHaveValue(url)
    expect(screen.getByTestId('remote-project-git-branch-input')).toHaveValue('develop')
    expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/original')
    mocks.summary.mockResolvedValue({ accounts: [{ domain: 'git.example:8443', effective: true }] })
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(mocks.sync).toHaveBeenCalledExactlyOnceWith(device.device_id, false)
    expect(clone).toHaveBeenLastCalledWith(device.device_id, {
      url,
      branch: 'develop',
      targetPath: '/original/repository',
    })
    expect(open).toHaveBeenCalledWith(device.device_id, '/original/repository', 'repository')
  })

  test.each(['network-error', 'repository-inaccessible', 'ssh-authentication-failed'])(
    'does not turn %s into a cloud login problem',
    async code => {
      const { close } = renderForm(vi.fn().mockRejectedValue(errorFor(code)))
      await fillForm()
      await userEvent.click(screen.getByTestId('remote-project-git-submit'))
      expect(await screen.findByTestId('remote-project-git-error')).toBeInTheDocument()
      expect(screen.queryByTestId('remote-project-git-configure')).not.toBeInTheDocument()
      expect(mocks.summary).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
    }
  )

  test('native devices never offer or write cloud credentials', async () => {
    renderForm(vi.fn().mockRejectedValue(errorFor('credentials-required')), {
      ...device,
      device_type: 'local',
    })
    await fillForm()
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    expect(await screen.findByTestId('remote-project-git-error')).toBeInTheDocument()
    expect(screen.queryByTestId('remote-project-git-configure')).not.toBeInTheDocument()
    expect(screen.getByTestId('remote-project-git-submit')).toHaveTextContent('重新检查')
    expect(mocks.summary).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  test('device refresh preserves the destination and editing clears stale access failures', async () => {
    const { rerender, props, home } = renderForm(
      vi.fn().mockRejectedValue(errorFor('credentials-required'))
    )
    await fillForm()
    fireEvent.change(screen.getByTestId('remote-project-git-parent-input'), {
      target: { value: '/chosen' },
    })
    rerender(
      <StandaloneGitProjectForm {...props} device={{ ...device, name: 'Refreshed device' }} />
    )
    expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/chosen')
    expect(home).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    expect(await screen.findByTestId('remote-project-git-error')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('remote-project-git-url-input'), {
      target: { value: 'https://other.example/repo.git' },
    })
    expect(screen.queryByTestId('remote-project-git-error')).not.toBeInTheDocument()
  })

  test('keeps fields and cancellation disabled until cloning and registration finish', async () => {
    let finish!: () => void
    const clone = vi.fn().mockReturnValue(
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    const { close } = renderForm(clone)
    await fillForm()
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    expect(screen.getByTestId('remote-project-git-status')).toHaveTextContent('克隆中')
    expect(screen.getByTestId('remote-project-git-url-input')).toBeDisabled()
    expect(screen.getByTestId('remote-project-git-cancel')).toBeDisabled()
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    expect(clone).toHaveBeenCalledOnce()
    await act(async () => finish())
    expect(close).toHaveBeenCalledOnce()
  })

  test('switching devices does not show the previous device error or reuse its destination', async () => {
    const { rerender, props } = renderForm(
      vi.fn().mockRejectedValue(errorFor('credentials-required'))
    )
    await fillForm()
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    expect(await screen.findByTestId('remote-project-git-error')).toBeInTheDocument()
    const home = vi.fn().mockResolvedValue('/other-device')
    rerender(
      <StandaloneGitProjectForm
        {...props}
        device={{ ...device, device_id: 'other-device' }}
        onGetDeviceHomeDirectory={home}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/other-device')
    )
    expect(screen.queryByTestId('remote-project-git-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('remote-project-git-url-input')).toHaveValue(url)
    expect(screen.getByTestId('remote-project-git-branch-input')).toHaveValue('develop')
    expect(screen.getByTestId('remote-project-git-submit')).toHaveTextContent('克隆并添加')
  })

  test('a removed device retains inputs until an explicit replacement is selected', async () => {
    const clone = vi.fn().mockRejectedValue(new Error('executor-not-found:original-device'))
    const { rerender, props, close, open } = renderForm(clone)
    await fillForm()
    fireEvent.change(screen.getByTestId('remote-project-git-parent-input'), {
      target: { value: '/chosen' },
    })
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    expect(await screen.findByTestId('remote-project-git-error')).toHaveTextContent(
      'executor-not-found'
    )
    rerender(<StandaloneGitProjectForm {...props} device={null} />)
    expect(screen.getByTestId('remote-project-git-url-input')).toHaveValue(url)
    expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/chosen')
    expect(screen.getByTestId('remote-project-git-branch-input')).toHaveValue('develop')
    expect(screen.getByTestId('remote-project-git-submit')).toBeDisabled()
    expect(close).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()

    clone.mockResolvedValue(undefined)
    rerender(
      <StandaloneGitProjectForm {...props} device={{ ...device, device_id: 'replacement' }} />
    )
    expect(screen.getByTestId('remote-project-git-parent-input')).toHaveValue('/chosen')
    await userEvent.click(screen.getByTestId('remote-project-git-submit'))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(clone).toHaveBeenLastCalledWith('replacement', {
      url,
      branch: 'develop',
      targetPath: '/chosen/repository',
    })
  })
})
