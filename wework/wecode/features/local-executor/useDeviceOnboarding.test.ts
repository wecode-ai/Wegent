import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/devices'
import { ONBOARDING_TIMEOUT_MS, useDeviceOnboarding } from './useDeviceOnboarding'

const deviceApiMocks = vi.hoisted(() => ({
  listDevices: vi.fn(),
  createCloudDevice: vi.fn(),
}))

const startupMocks = vi.hoisted(() => ({
  startLocalExecutorStartupCheck: vi.fn(() => Promise.resolve()),
  resetLocalExecutorStartupCheck: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/api/devices', () => ({
  createDeviceApi: () => deviceApiMocks,
}))
vi.mock('@/api/http', () => ({ createHttpClient: () => ({}) }))
vi.mock('@/config/runtime', () => ({ getRuntimeConfig: () => ({ apiBaseUrl: '/api' }) }))
vi.mock('./local-executor-startup', () => startupMocks)

function makeDevice(status: DeviceInfo['status']): DeviceInfo {
  return {
    id: 1,
    device_id: 'dev-1',
    name: 'Local',
    status,
    is_default: true,
    device_type: 'local',
    bind_shell: 'claudecode',
  }
}

describe('useDeviceOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    deviceApiMocks.createCloudDevice.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('triggers local device creation on mount', () => {
    deviceApiMocks.listDevices.mockResolvedValue([])
    renderHook(() => useDeviceOnboarding({ onReady: vi.fn() }))
    expect(startupMocks.startLocalExecutorStartupCheck).toHaveBeenCalledTimes(1)
  })

  test('auto-creates a cloud device on mount', async () => {
    deviceApiMocks.listDevices.mockResolvedValue([makeDevice('offline')])

    const { result } = renderHook(() => useDeviceOnboarding({ onReady: vi.fn() }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(deviceApiMocks.createCloudDevice).toHaveBeenCalledTimes(1)
    expect(result.current.cloudCreated).toBe(true)
  })

  test('calls onReady once an online device appears', async () => {
    const onReady = vi.fn()
    deviceApiMocks.listDevices
      .mockResolvedValueOnce([makeDevice('offline')])
      .mockResolvedValue([makeDevice('online')])

    renderHook(() => useDeviceOnboarding({ onReady }))

    // initial poll: offline
    await act(async () => {
      await Promise.resolve()
    })
    expect(onReady).not.toHaveBeenCalled()

    // next interval: online
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  test('flags timeout after the limit when cloud creation also fails', async () => {
    deviceApiMocks.listDevices.mockResolvedValue([makeDevice('offline')])
    deviceApiMocks.createCloudDevice.mockRejectedValue(new Error('cloud down'))

    const { result } = renderHook(() => useDeviceOnboarding({ onReady: vi.fn() }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ONBOARDING_TIMEOUT_MS + 5_000)
    })

    expect(result.current.timedOut).toBe(true)
  })

  test('auto cloud creation suppresses the timeout and keeps polling', async () => {
    deviceApiMocks.listDevices.mockResolvedValue([makeDevice('offline')])

    const { result } = renderHook(() => useDeviceOnboarding({ onReady: vi.fn() }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(deviceApiMocks.createCloudDevice).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ONBOARDING_TIMEOUT_MS + 10_000)
    })
    expect(result.current.timedOut).toBe(false)
  })

  test('retry re-runs startup check and clears timeout', async () => {
    deviceApiMocks.listDevices.mockResolvedValue([makeDevice('offline')])
    deviceApiMocks.createCloudDevice.mockRejectedValue(new Error('cloud down'))

    const { result } = renderHook(() => useDeviceOnboarding({ onReady: vi.fn() }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ONBOARDING_TIMEOUT_MS + 5_000)
    })
    expect(result.current.timedOut).toBe(true)

    await act(async () => {
      result.current.retry()
      await Promise.resolve()
    })
    expect(startupMocks.resetLocalExecutorStartupCheck).toHaveBeenCalledTimes(1)
    expect(result.current.timedOut).toBe(false)
  })
})
