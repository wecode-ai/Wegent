import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import {
  refreshLocalExecutorCloudConnectionStatus,
  resetLocalExecutorCloudConnectionStatus,
  setLocalExecutorCloudConnectionStatus,
  useLocalExecutorCloudConnectionStatus,
} from './localExecutorCloudConnectionStatus'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/desktop/localExecutor', () => ({ requestLocalExecutor: request }))

beforeEach(() => {
  resetLocalExecutorCloudConnectionStatus()
  request.mockReset()
})

test('shares a live status read between background polling and an operation guard', async () => {
  let finish!: (value: { configured: boolean; connected: boolean }) => void
  request.mockReturnValue(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const polling = refreshLocalExecutorCloudConnectionStatus('/api')
  const operation = refreshLocalExecutorCloudConnectionStatus('/api')
  expect(request).toHaveBeenCalledTimes(1)
  finish({ configured: true, connected: true })
  expect(await polling).toEqual({ configured: true, connected: true })
  expect(await operation).toEqual({ configured: true, connected: true })
})

test('does not reuse a pending read after the account connection is reset', async () => {
  let finish!: (value: { configured: boolean; connected: boolean }) => void
  request.mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const old = refreshLocalExecutorCloudConnectionStatus('/api')
  resetLocalExecutorCloudConnectionStatus()
  request.mockResolvedValueOnce({ configured: false, connected: false })
  const current = refreshLocalExecutorCloudConnectionStatus('/api')
  expect(request).toHaveBeenCalledTimes(2)
  finish({ configured: true, connected: true })
  expect(await old).toBeNull()
  expect(await current).toEqual({ configured: false, connected: false })
})

test('distinguishes missing Executor configuration from a failed status read', async () => {
  request.mockResolvedValueOnce({ configured: false, connected: false })
  expect(await refreshLocalExecutorCloudConnectionStatus('/api')).toEqual({
    configured: false,
    connected: false,
  })
  request.mockRejectedValueOnce(new Error('Executor is restarting'))
  expect(await refreshLocalExecutorCloudConnectionStatus('/api')).toBeNull()
})

test('does not publish a query that finishes after connection state was reset and replaced', async () => {
  let finish!: (value: { configured: boolean; connected: boolean }) => void
  request.mockReturnValue(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const pending = refreshLocalExecutorCloudConnectionStatus('/old-api')
  resetLocalExecutorCloudConnectionStatus()
  setLocalExecutorCloudConnectionStatus({
    apiBaseUrl: '/current-api',
    connected: true,
    configured: true,
  })
  const hook = renderHook(useLocalExecutorCloudConnectionStatus)

  await act(async () => {
    finish({ configured: true, connected: false })
    await pending
  })

  expect(hook.result.current).toMatchObject({ apiBaseUrl: '/current-api', connected: true })
})

test('keeps the latest query when an earlier query fails later', async () => {
  let rejectOld!: (reason: Error) => void
  request.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectOld = reject
    })
  )
  const old = refreshLocalExecutorCloudConnectionStatus('/old-api')
  request.mockResolvedValueOnce({ configured: true, connected: true })
  await refreshLocalExecutorCloudConnectionStatus('/current-api')
  const hook = renderHook(useLocalExecutorCloudConnectionStatus)

  await act(async () => {
    rejectOld(new Error('Old connection closed'))
    await old
  })

  expect(hook.result.current).toMatchObject({ apiBaseUrl: '/current-api', connected: true })
})

test('checks health on every poll without rendering unchanged connection state', async () => {
  request.mockResolvedValue({ configured: true, connected: true })
  const rendered = vi.fn()
  const hook = renderHook(() => {
    rendered()
    return useLocalExecutorCloudConnectionStatus()
  })
  await act(async () => {
    await refreshLocalExecutorCloudConnectionStatus('/api')
  })
  const connected = hook.result.current
  const renders = rendered.mock.calls.length

  await act(async () => {
    await refreshLocalExecutorCloudConnectionStatus('/api')
  })

  expect(request).toHaveBeenCalledTimes(2)
  expect(hook.result.current).toBe(connected)
  expect(rendered).toHaveBeenCalledTimes(renders)

  request.mockResolvedValue({ configured: true, connected: false })
  await act(async () => {
    await refreshLocalExecutorCloudConnectionStatus('/api')
  })
  expect(hook.result.current.connected).toBe(false)
  expect(rendered).toHaveBeenCalledTimes(renders + 1)
})

test('an unchanged explicit state still invalidates older pending health reads', async () => {
  setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: true, configured: true })
  let finish!: (value: { configured: boolean; connected: boolean }) => void
  request.mockReturnValue(new Promise(resolve => (finish = resolve)))
  const pending = refreshLocalExecutorCloudConnectionStatus('/api')
  const hook = renderHook(useLocalExecutorCloudConnectionStatus)
  const current = hook.result.current

  await act(async () => {
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl: '/api', connected: true, configured: true })
    finish({ configured: true, connected: false })
    expect(await pending).toBeNull()
  })

  expect(hook.result.current).toBe(current)
})

test('publishes configuration readiness independently of Device connectivity', async () => {
  const hook = renderHook(useLocalExecutorCloudConnectionStatus)
  const before = hook.result.current
  request.mockResolvedValue({ configured: true, connected: false })
  await act(async () => {
    await refreshLocalExecutorCloudConnectionStatus('/api')
  })
  expect(hook.result.current).toMatchObject({ configured: true, connected: false })
  expect(hook.result.current).not.toBe(before)
  const configured = hook.result.current
  request.mockRejectedValueOnce(new Error('Status read failed'))
  await act(async () => {
    await refreshLocalExecutorCloudConnectionStatus('/api')
  })
  expect(hook.result.current).toBe(configured)
  request.mockResolvedValueOnce({ configured: false, connected: false })
  await act(async () => {
    await refreshLocalExecutorCloudConnectionStatus('/api')
  })
  expect(hook.result.current).toMatchObject({ configured: false, connected: false })
})
