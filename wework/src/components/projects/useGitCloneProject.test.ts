import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useGitCloneProject } from './useGitCloneProject'
import { createDeviceApi } from '@/api/devices'
import { ApiError } from '@/api/http'
import type { DeviceInfo } from '@/types/api'
import '@/i18n'

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  sync: vi.fn(),
  cloud: {
    isConnected: true,
    backendUrl: 'https://cloud.example',
    apiBaseUrl: 'https://cloud.example/api',
    token: 'synthetic',
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

const device = {
  device_id: 'original-device',
  device_type: 'remote',
  bind_shell: 'claudecode',
  status: 'online',
} as DeviceInfo
const input = {
  url: 'https://git.example:8443/owner/repo.git',
  branch: 'develop',
  targetPath: '/original/repo',
}
const failure = {
  code: 'credentials-required',
  domain: 'git.example:8443',
  message: 'Configure Git credentials',
}
const authError = () => new Error(`git-access:${JSON.stringify(failure)}`)
const configured = () =>
  mocks.summary.mockResolvedValue({
    accounts: [{ domain: 'git.example:8443', effective: true }],
    effective_count: 1,
  })

describe('Git clone operation recovery', () => {
  beforeEach(() => {
    mocks.cloud.isConnected = true
    mocks.cloud.user = { id: 1 }
    mocks.summary.mockReset().mockResolvedValue({ accounts: [], effective_count: 0 })
    mocks.sync.mockReset().mockResolvedValue({ status: 'synced' })
  })

  test('public repositories do not depend on cloud APIs', async () => {
    mocks.summary.mockRejectedValue(new Error('Cloud unavailable'))
    const clone = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useGitCloneProject({ device, clone, open }))
    await act(async () => {
      await result.current.submit(input)
    })
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(device.device_id, input.targetPath, 'repo')
    )
    expect(mocks.summary).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  test('offers device recovery when a cached online device disappears from the backend', async () => {
    const api = createDeviceApi({
      post: vi.fn().mockRejectedValue(new ApiError('Device not found or access denied', 404)),
    } as never)
    const clone = vi.fn(async (deviceId: string) => api.createDirectory(deviceId, '/original'))
    const open = vi.fn()
    const { result } = renderHook(() => useGitCloneProject({ device, clone, open }))

    await act(async () => {
      expect(await result.current.submit(input)).toBe(false)
    })

    expect(result.current.deviceRecovery).toBe(true)
    expect(result.current.operation).toMatchObject({
      ...input,
      deviceId: device.device_id,
      status: 'failed',
      failureReason: 'executor-not-found',
      error: `executor-not-found:${device.device_id}`,
    })
    expect(open).not.toHaveBeenCalled()
    expect(mocks.summary).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  test('retains the operation and syncs the original device before a single revalidated resume', async () => {
    const clone = vi.fn().mockRejectedValueOnce(authError()).mockResolvedValue(undefined)
    const open = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useGitCloneProject({ device, clone, open }))
    await act(async () => {
      await result.current.submit(input)
    })
    expect(result.current.operation?.status).toBe('waiting-configuration')
    expect(mocks.sync).not.toHaveBeenCalled()
    const original = result.current.operation
    expect(original).toMatchObject({ ...input, deviceId: device.device_id, gitFailure: failure })
    configured()
    act(() => {
      void result.current.submit(input)
      void result.current.submit(input)
    })
    await waitFor(() => expect(open).toHaveBeenCalledOnce())
    expect(mocks.sync).toHaveBeenCalledExactlyOnceWith(device.device_id, false)
    expect(clone).toHaveBeenCalledTimes(2)
    expect(clone.mock.calls[1]).toEqual([device.device_id, input])
    expect(result.current.operation).toBeNull()
  })

  test('automatically repairs unsynced accounts once but does not loop on invalid credentials', async () => {
    configured()
    const clone = vi.fn().mockRejectedValue(authError())
    const open = vi.fn()
    const { result } = renderHook(() => useGitCloneProject({ device, clone, open }))
    await act(async () => {
      await result.current.submit(input)
    })
    expect(result.current.operation?.status).toBe('waiting-configuration')
    expect(mocks.sync).toHaveBeenCalledOnce()
    expect(clone).toHaveBeenCalledTimes(2)
    expect(open).not.toHaveBeenCalled()
  })

  test('missing exact-domain account never clears the device', async () => {
    const clone = vi.fn().mockRejectedValue(authError())
    const { result } = renderHook(() => useGitCloneProject({ device, clone, open: vi.fn() }))
    await act(async () => {
      await result.current.submit(input)
    })
    mocks.summary.mockResolvedValue({
      accounts: [{ domain: 'git.example', effective: true }],
      effective_count: 1,
    })
    await act(async () => {
      await result.current.submit(input)
    })
    await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(2))
    expect(result.current.operation?.status).toBe('waiting-configuration')
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(clone).toHaveBeenCalledOnce()
  })

  test('native local recovery does not write cloud credentials', async () => {
    const local = { ...device, device_type: 'local' } as DeviceInfo
    const clone = vi.fn().mockRejectedValueOnce(authError()).mockResolvedValue(undefined)
    const open = vi.fn()
    const { result } = renderHook(() => useGitCloneProject({ device: local, clone, open }))
    await act(async () => {
      await result.current.submit(input)
    })
    expect(result.current.operation?.status).toBe('waiting-configuration')
    await act(async () => {
      await result.current.submit(input)
    })
    await waitFor(() => expect(open).toHaveBeenCalledOnce())
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(mocks.summary).not.toHaveBeenCalled()
  })

  test('unmount suppresses later open and duplicate submissions', async () => {
    let resolve!: () => void
    const clone = vi.fn().mockReturnValue(
      new Promise<void>(done => {
        resolve = done
      })
    )
    const open = vi.fn()
    const { result, unmount } = renderHook(() => useGitCloneProject({ device, clone, open }))
    act(() => {
      void result.current.submit(input)
      void result.current.submit(input)
    })
    expect(clone).toHaveBeenCalledOnce()
    unmount()
    await act(async () => resolve())
    expect(open).not.toHaveBeenCalled()
  })

  test('does not sync a different cloud identity after configuration', async () => {
    const clone = vi.fn().mockRejectedValue(authError())
    const { result, rerender } = renderHook(() =>
      useGitCloneProject({ device, clone, open: vi.fn() })
    )
    await act(async () => {
      await result.current.submit(input)
    })
    configured()
    mocks.cloud.user = { id: 2 }
    rerender()
    await act(async () => {
      await result.current.submit(input)
    })
    expect(result.current.operation?.status).toBe('waiting-configuration')
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(clone).toHaveBeenCalledOnce()
  })

  test('a late authentication rejection after unmount does not query or sync accounts', async () => {
    let rejectClone!: (error: Error) => void
    const clone = vi.fn().mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectClone = reject
      })
    )
    const open = vi.fn()
    const { result, unmount } = renderHook(() => useGitCloneProject({ device, clone, open }))
    act(() => {
      void result.current.submit(input)
    })
    unmount()
    await act(async () => rejectClone(authError()))
    expect(mocks.summary).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  test('network and repository permission errors never request cloud authentication', async () => {
    for (const code of ['network-error', 'repository-inaccessible', 'ssh-authentication-failed']) {
      const clone = vi
        .fn()
        .mockRejectedValue(new Error(`git-access:${JSON.stringify({ ...failure, code })}`))
      const { result, unmount } = renderHook(() =>
        useGitCloneProject({ device, clone, open: vi.fn() })
      )
      await act(async () => {
        await result.current.submit(input)
      })
      expect(result.current.operation?.status).toBe('failed')
      expect(mocks.summary).not.toHaveBeenCalled()
      unmount()
    }
  })

  test('sync failure retains the actionable authentication error without starting a clone again', async () => {
    configured()
    mocks.sync.mockRejectedValue(new Error('Device offline during sync'))
    const clone = vi.fn().mockRejectedValue(authError())
    const { result } = renderHook(() => useGitCloneProject({ device, clone, open: vi.fn() }))
    await act(async () => {
      await result.current.submit(input)
    })
    expect(result.current.operation?.status).toBe('waiting-configuration')
    expect(result.current.operation?.gitFailure).toEqual(failure)
    expect(result.current.operation?.error).toBe('Device offline during sync')
    expect(clone).toHaveBeenCalledOnce()
  })

  test('a failed recheck replaces the earlier authentication diagnostic', async () => {
    const clone = vi
      .fn()
      .mockRejectedValueOnce(authError())
      .mockRejectedValue(new Error('executor-offline: disconnected'))
    const { result } = renderHook(() => useGitCloneProject({ device, clone, open: vi.fn() }))
    await act(async () => {
      await result.current.submit(input)
    })
    configured()
    await act(async () => {
      await result.current.submit(input)
    })
    expect(result.current.operation?.status).toBe('failed')
    expect(result.current.operation?.gitFailure).toBeUndefined()
    expect(result.current.operation?.failureReason).toBe('executor-offline')
  })

  test('an open failure retries registration without cloning again', async () => {
    const clone = vi.fn().mockResolvedValue(undefined)
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('Cannot register'))
      .mockResolvedValue(undefined)
    const { result } = renderHook(() => useGitCloneProject({ device, clone, open }))
    await act(async () => {
      await result.current.submit(input)
    })
    expect(result.current.operation?.failureStage).toBe('open')
    await act(async () => {
      await result.current.submit(input)
    })
    expect(clone).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledTimes(2)
    expect(result.current.operation).toBeNull()
  })

  test('changing cloud identity while reading accounts never writes credentials', async () => {
    let finishSummary!: (value: unknown) => void
    mocks.summary.mockReturnValue(
      new Promise(resolve => {
        finishSummary = resolve
      })
    )
    const clone = vi.fn().mockRejectedValue(authError())
    const open = vi.fn()
    const { result, rerender } = renderHook(() => useGitCloneProject({ device, clone, open }))
    act(() => {
      void result.current.submit(input)
    })
    await waitFor(() => expect(mocks.summary).toHaveBeenCalledOnce())
    mocks.cloud.user = { id: 2 }
    rerender()
    await act(async () =>
      finishSummary({ accounts: [{ domain: 'git.example:8443', effective: true }] })
    )
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(clone).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
    expect(result.current.operation?.status).toBe('waiting-configuration')
    expect(result.current.canConfigure).toBe(false)
  })

  test('changing cloud identity during sync cannot resume the operation under another account', async () => {
    configured()
    let finishSync!: () => void
    mocks.sync.mockReturnValue(
      new Promise<void>(resolve => {
        finishSync = resolve
      })
    )
    const clone = vi.fn().mockRejectedValue(authError())
    const open = vi.fn()
    const { result, rerender } = renderHook(() => useGitCloneProject({ device, clone, open }))
    act(() => {
      void result.current.submit(input)
    })
    await waitFor(() => expect(result.current.operation?.status).toBe('syncing'))
    mocks.cloud.user = { id: 2 }
    rerender()
    await act(async () => finishSync())
    expect(result.current.operation?.status).toBe('waiting-configuration')
    expect(clone).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })
})
