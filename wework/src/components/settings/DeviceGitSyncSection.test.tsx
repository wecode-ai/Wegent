import i18n from '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/devices'
import type { DeviceGitAccountSyncResult, GitAccountSyncSummary } from '@/types/gitCredentials'
import { DeviceGitSyncSection } from './DeviceGitSyncSection'

const context = vi.hoisted(() => ({
  isConnected: true,
  apiBaseUrl: 'https://api.example.test',
  backendUrl: 'https://api.example.test',
  webUrl: '',
  token: 'first',
  user: { id: 7 },
  refreshUser: vi.fn(),
}))
const apiFactory = vi.hoisted(() => vi.fn())
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => context,
}))
vi.mock('./settings-cloud-api', () => ({ createSettingsDeviceApi: apiFactory }))
function device(id = 'remote'): DeviceInfo {
  return {
    id: 1,
    device_id: id,
    name: id,
    device_type: 'remote',
    status: 'online',
    is_default: false,
    bind_shell: 'claudecode',
  }
}
function summary(count = 1): GitAccountSyncSummary {
  return {
    accounts: count
      ? [
          {
            id: 'account',
            domain: 'code.example.test',
            provider: 'gitlab',
            login: null,
            email: null,
            effective: true,
            duplicate_of: null,
          },
        ]
      : [],
    effective_count: count,
    duplicate_count: 0,
  }
}
function receipt(device_id = 'remote'): DeviceGitAccountSyncResult {
  return {
    device_id,
    status: 'synced',
    synced_domains: ['code.example.test'],
    removed_domains: [],
    duplicate_domains: [],
    identity_warning_domains: [],
    cli: [],
    warning_codes: [],
  }
}
function source() {
  return {
    getGitAccountSyncSummary: vi.fn().mockResolvedValue(summary()),
    getAllDevices: vi.fn().mockResolvedValue([device()]),
    syncGitAccounts: vi.fn().mockResolvedValue(receipt()),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
let current: ReturnType<typeof source>
beforeEach(() => {
  context.isConnected = true
  context.apiBaseUrl = 'https://api.example.test'
  context.token = 'first'
  context.user = { id: 7 }
  context.refreshUser.mockReset().mockResolvedValue(null)
  apiFactory.mockReset().mockImplementation(() => current)
  current = source()
})
async function select() {
  await screen.findByTestId('git-device-sync-accounts')
  await waitFor(() => expect(screen.getByTestId('git-device-sync-select')).toBeEnabled())
  fireEvent.change(screen.getByTestId('git-device-sync-select'), { target: { value: 'remote' } })
}

test('publishes account metadata independently while the device inventory is pending', async () => {
  const pending = deferred<DeviceInfo[]>()
  current.getAllDevices.mockReturnValue(pending.promise)
  render(<DeviceGitSyncSection />)
  expect(await screen.findByTestId('git-device-sync-accounts')).toHaveTextContent(
    'code.example.test'
  )
  expect(screen.getByTestId('git-device-sync-select')).toBeDisabled()
  expect(screen.getByTestId('git-device-sync-select')).not.toHaveTextContent('没有可同步的在线设备')
  await act(async () => pending.resolve([device()]))
  expect(screen.getByTestId('git-device-sync-select')).toBeEnabled()
})

test('keeps account metadata visible on device failure instead of reporting an empty inventory', async () => {
  current.getAllDevices.mockRejectedValueOnce(new Error('Devices unavailable'))
  render(<DeviceGitSyncSection />)
  expect(await screen.findByTestId('git-device-sync-accounts')).toBeInTheDocument()
  expect(screen.getByTestId('git-device-sync-select')).not.toHaveTextContent('没有可同步的在线设备')
  expect(await screen.findByTestId('git-device-sync-error')).toHaveTextContent(
    'Devices unavailable'
  )
  expect(screen.getByTestId('git-device-sync-submit')).toBeDisabled()
})

test('uses supplied devices without an initial inventory request or parent refresh', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  render(<DeviceGitSyncSection devices={[device()]} onRefreshDevices={refresh} />)
  await select()
  expect(current.getAllDevices).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('git-device-sync-refresh'))
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  expect(current.getAllDevices).not.toHaveBeenCalled()
})

test('does not refetch or clear the selected device when only a callback or language changes', async () => {
  const { rerender } = render(
    <DeviceGitSyncSection devices={[device()]} onRefreshDevices={vi.fn()} />
  )
  await select()
  rerender(<DeviceGitSyncSection devices={[device()]} onRefreshDevices={vi.fn()} />)
  const previousLanguage = i18n.language
  try {
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(screen.getByTestId('git-device-sync-select')).toHaveValue('remote')
    expect(current.getGitAccountSyncSummary).toHaveBeenCalledTimes(1)
    expect(current.getAllDevices).not.toHaveBeenCalled()
  } finally {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})

test('does not duplicate a still-pending inventory read when refreshing the summary', async () => {
  const pending = deferred<DeviceInfo[]>()
  current.getAllDevices.mockReturnValue(pending.promise)
  render(<DeviceGitSyncSection />)
  await screen.findByTestId('git-device-sync-accounts')
  fireEvent.click(screen.getByTestId('git-device-sync-refresh'))
  await waitFor(() => expect(current.getGitAccountSyncSummary).toHaveBeenCalledTimes(2))
  expect(current.getAllDevices).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve([device()]))
})

test('does not display old metadata or an old operation receipt after the account changes', async () => {
  const old = current,
    next = source(),
    pending = deferred<DeviceGitAccountSyncResult>()
  old.syncGitAccounts.mockReturnValue(pending.promise)
  const { rerender } = render(<DeviceGitSyncSection />)
  await select()
  fireEvent.click(screen.getByTestId('git-device-sync-submit'))
  expect(old.syncGitAccounts).toHaveBeenCalledWith('remote', false)
  context.token = 'next'
  current = next
  rerender(<DeviceGitSyncSection />)
  expect(screen.queryByTestId('git-device-sync-accounts')).not.toBeInTheDocument()
  await screen.findByTestId('git-device-sync-accounts')
  expect(screen.getByTestId('git-device-sync-select')).toHaveValue('')
  await act(async () => pending.resolve(receipt()))
  expect(screen.queryByTestId('git-device-sync-result')).not.toBeInTheDocument()
  expect(next.syncGitAccounts).not.toHaveBeenCalled()
})

test('cancels a clear confirmation on account changes and requires a new explicit selection', async () => {
  current.getGitAccountSyncSummary.mockResolvedValue(summary(0))
  const old = current
  const { rerender } = render(<DeviceGitSyncSection />)
  await select()
  fireEvent.click(screen.getByTestId('git-device-sync-clear'))
  expect(screen.getByTestId('git-device-sync-clear-dialog')).toBeInTheDocument()
  context.user = { id: 8 }
  current = source()
  current.getGitAccountSyncSummary.mockResolvedValue(summary(0))
  rerender(<DeviceGitSyncSection />)
  expect(screen.queryByTestId('git-device-sync-clear-dialog')).not.toBeInTheDocument()
  await screen.findByTestId('git-device-sync-accounts')
  expect(screen.getByTestId('git-device-sync-select')).toHaveValue('')
  expect(old.syncGitAccounts).not.toHaveBeenCalled()
  expect(current.syncGitAccounts).not.toHaveBeenCalled()
})

test('dismisses a confirmation if the selected target is removed and does not revive it later', async () => {
  current.getGitAccountSyncSummary.mockResolvedValue(summary(0))
  const { rerender } = render(<DeviceGitSyncSection devices={[device()]} />)
  await select()
  fireEvent.click(screen.getByTestId('git-device-sync-clear'))
  rerender(<DeviceGitSyncSection devices={[]} />)
  expect(screen.queryByTestId('git-device-sync-clear-dialog')).not.toBeInTheDocument()
  rerender(<DeviceGitSyncSection devices={[device()]} />)
  expect(screen.queryByTestId('git-device-sync-clear-dialog')).not.toBeInTheDocument()
  expect(current.syncGitAccounts).not.toHaveBeenCalled()
})

test('accepts one sync for rapid duplicate submissions', async () => {
  const pending = deferred<DeviceGitAccountSyncResult>()
  current.syncGitAccounts.mockReturnValue(pending.promise)
  render(<DeviceGitSyncSection />)
  await select()
  act(() => {
    fireEvent.click(screen.getByTestId('git-device-sync-submit'))
    fireEvent.click(screen.getByTestId('git-device-sync-submit'))
  })
  expect(current.syncGitAccounts).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve(receipt()))
})

test('preserves cached summary and selection when a refresh fails', async () => {
  render(<DeviceGitSyncSection />)
  await select()
  current.getGitAccountSyncSummary.mockRejectedValueOnce(new Error('Refresh unavailable'))
  fireEvent.click(screen.getByTestId('git-device-sync-refresh'))
  expect(screen.getByTestId('git-device-sync-accounts')).toBeInTheDocument()
  expect(await screen.findByTestId('git-device-sync-error')).toHaveTextContent(
    'Refresh unavailable'
  )
  expect(screen.getByTestId('git-device-sync-select')).toHaveValue('remote')
})

test('does not query after disconnecting or apply a pending old summary', async () => {
  const pending = deferred<GitAccountSyncSummary>()
  current.getGitAccountSyncSummary.mockReturnValue(pending.promise)
  const { rerender } = render(<DeviceGitSyncSection />)
  await waitFor(() => expect(current.getGitAccountSyncSummary).toHaveBeenCalledTimes(1))
  context.isConnected = false
  rerender(<DeviceGitSyncSection />)
  expect(screen.getByTestId('git-device-sync-disconnected')).toBeInTheDocument()
  await act(async () => pending.resolve(summary()))
  expect(screen.queryByTestId('git-device-sync-accounts')).not.toBeInTheDocument()
  expect(current.getGitAccountSyncSummary).toHaveBeenCalledTimes(1)
})

test('ignores a late old summary instead of replacing current accounts with an empty list', async () => {
  const old = current,
    pending = deferred<GitAccountSyncSummary>()
  old.getGitAccountSyncSummary.mockReturnValue(pending.promise)
  const { rerender } = render(<DeviceGitSyncSection />)
  await waitFor(() => expect(old.getGitAccountSyncSummary).toHaveBeenCalledTimes(1))
  context.token = 'next'
  current = source()
  rerender(<DeviceGitSyncSection />)
  await select()
  await act(async () => pending.resolve(summary(0)))
  expect(screen.queryByTestId('git-device-sync-clear')).not.toBeInTheDocument()
  expect(screen.getByTestId('git-device-sync-submit')).toBeEnabled()
})

test('coalesces simultaneous unauthorized reads into one identity refresh', async () => {
  const pending = deferred<null>()
  context.refreshUser.mockReturnValue(pending.promise)
  current.getGitAccountSyncSummary.mockRejectedValue({ status: 401 })
  current.getAllDevices.mockRejectedValue({ status: 401 })
  render(<DeviceGitSyncSection />)
  expect(await screen.findByTestId('git-device-sync-error')).toHaveTextContent('云端登录已失效')
  expect(context.refreshUser).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve(null))
  expect(current.syncGitAccounts).not.toHaveBeenCalled()
})

test('does not refresh identity for a late unauthorized response after disconnection', async () => {
  const pending = deferred<GitAccountSyncSummary>()
  current.getGitAccountSyncSummary.mockReturnValue(pending.promise)
  const { rerender } = render(<DeviceGitSyncSection />)
  await waitFor(() => expect(current.getGitAccountSyncSummary).toHaveBeenCalledTimes(1))
  context.isConnected = false
  rerender(<DeviceGitSyncSection />)
  await act(async () => pending.reject({ status: 401 }))
  expect(context.refreshUser).not.toHaveBeenCalled()
  expect(screen.getByTestId('git-device-sync-disconnected')).toBeInTheDocument()
})

test('coalesces a pending parent inventory refresh while allowing the summary to refresh', async () => {
  const pending = deferred<void>(),
    refresh = vi.fn(() => pending.promise)
  render(<DeviceGitSyncSection devices={[device()]} onRefreshDevices={refresh} />)
  await select()
  fireEvent.click(screen.getByTestId('git-device-sync-refresh'))
  await waitFor(() => expect(screen.getByTestId('git-device-sync-refresh')).toBeEnabled())
  fireEvent.click(screen.getByTestId('git-device-sync-refresh'))
  await waitFor(() => expect(current.getGitAccountSyncSummary).toHaveBeenCalledTimes(3))
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(current.getAllDevices).not.toHaveBeenCalled()
  await act(async () => pending.resolve())
})
