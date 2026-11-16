import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { StandInTelemetryAgent } from './StandInTelemetryAgent'

const mocks = vi.hoisted(() => ({
  enabled: true,
  asked: true,
  loaded: true,
  source: null as unknown,
  identity: vi.fn(),
  configure: vi.fn(),
  collect: vi.fn(),
  flush: vi.fn(),
  clear: vi.fn(),
  clearAll: vi.fn(),
}))
vi.mock('@/features/notifications/NotificationTaskSourceContext', () => ({
  useNotificationTaskSource: () => mocks.source,
}))
vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => ({
    loaded: mocks.loaded,
    preferences: { telemetryConsentAsked: mocks.asked, telemetryEnabled: mocks.enabled },
  }),
}))
vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: () => 'main' }))
vi.mock('./client', () => ({
  useTelemetryEnabled: () => mocks.enabled,
  standInCollectionSince: () => 1234,
}))
vi.mock('./standInDelivery', () => ({
  queuedStandInDevices: () => ['local'],
  clearStandInDeliveries: mocks.clearAll,
  createStandInDelivery: () => ({ collect: mocks.collect, flush: mocks.flush, clear: mocks.clear }),
}))

beforeEach(() => {
  mocks.enabled = true
  mocks.asked = true
  mocks.loaded = true
  for (const fn of [
    mocks.identity,
    mocks.configure,
    mocks.collect,
    mocks.flush,
    mocks.clear,
    mocks.clearAll,
  ])
    fn.mockReset()
  mocks.identity.mockResolvedValue({ deviceId: 'local', runtimeInstanceId: 'runtime-1' })
  mocks.configure.mockResolvedValue(undefined)
  mocks.collect.mockResolvedValue(undefined)
  mocks.flush.mockResolvedValue(undefined)
  mocks.source = {
    userId: 7,
    services: {
      standInApi: { configureTelemetry: mocks.configure },
      getLocalRuntimeSidebarIdentity: mocks.identity,
    },
    devices: [
      { device_id: 'remote', status: 'online' },
      { device_id: 'offline', status: 'offline' },
    ],
  }
})

afterEach(() => vi.useRealTimers())

describe('stand-in telemetry main-window lifecycle', () => {
  test('collects without opening a stand-in page and routes the consent boundary to online devices', async () => {
    render(<StandInTelemetryAgent />)
    await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(2))
    expect(mocks.configure).toHaveBeenCalledWith(7, 'local', true, 1234)
    expect(mocks.configure).toHaveBeenCalledWith(7, 'remote', true, 1234)
    expect(mocks.configure.mock.calls.flat()).not.toContain('offline')
  })
  test('clears all local account queues before an unavailable Executor can reconnect', async () => {
    mocks.enabled = false
    mocks.identity.mockResolvedValue(null)
    render(<StandInTelemetryAgent />)
    await waitFor(() => expect(mocks.clearAll).toHaveBeenCalled())
    expect(mocks.collect).not.toHaveBeenCalled()
    expect(mocks.flush).not.toHaveBeenCalled()
  })
  test('does not overwrite an Executor policy while initial consent is unknown', () => {
    mocks.enabled = false
    mocks.asked = false
    render(<StandInTelemetryAgent />)
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.clearAll).not.toHaveBeenCalled()
  })
  test('propagates a saved refusal to all connected Executors', async () => {
    mocks.enabled = false
    render(<StandInTelemetryAgent />)
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(2))
    expect(mocks.configure).toHaveBeenCalledWith(7, 'local', false, 1234)
    expect(mocks.collect).not.toHaveBeenCalled()
    expect(mocks.flush).not.toHaveBeenCalled()
  })

  test.each([false, true])(
    'does not rewrite a confirmed local policy (%s) on idle polls',
    async enabled => {
      vi.useFakeTimers()
      mocks.enabled = enabled
      await act(async () => render(<StandInTelemetryAgent />))
      await act(async () => vi.advanceTimersByTimeAsync(15_000))

      expect(mocks.identity).toHaveBeenCalledTimes(4)
      expect(mocks.configure.mock.calls.filter(([, device]) => device === 'local')).toHaveLength(1)
      expect(mocks.configure.mock.calls.filter(([, device]) => device === 'remote')).toHaveLength(4)
      if (enabled) expect(mocks.collect).toHaveBeenCalledTimes(8)
      else expect(mocks.collect).not.toHaveBeenCalled()
    }
  )

  test('resends policy after an executor replacement and retries failed configuration', async () => {
    vi.useFakeTimers()
    mocks.source = { ...(mocks.source as object), devices: [] }
    mocks.configure.mockRejectedValueOnce(new Error('Disconnected'))
    await act(async () => render(<StandInTelemetryAgent />))
    expect(mocks.collect).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(mocks.configure).toHaveBeenCalledTimes(2)
    expect(mocks.collect).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(mocks.configure).toHaveBeenCalledTimes(2)

    mocks.identity.mockResolvedValue({ deviceId: 'local', runtimeInstanceId: 'runtime-2' })
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(mocks.configure).toHaveBeenCalledTimes(3)
  })

  test('synchronizes changed consent before resuming local collection', async () => {
    vi.useFakeTimers()
    mocks.source = { ...(mocks.source as object), devices: [] }
    mocks.enabled = false
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(<StandInTelemetryAgent />)
    })
    expect(mocks.configure).toHaveBeenLastCalledWith(7, 'local', false, 1234)
    expect(mocks.collect).not.toHaveBeenCalled()

    mocks.enabled = true
    await act(async () => view.rerender(<StandInTelemetryAgent />))
    expect(mocks.configure).toHaveBeenLastCalledWith(7, 'local', true, 1234)
    expect(mocks.collect).toHaveBeenCalledOnce()
    mocks.enabled = false
    await act(async () => view.rerender(<StandInTelemetryAgent />))
    expect(mocks.configure).toHaveBeenLastCalledWith(7, 'local', false, 1234)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(mocks.configure).toHaveBeenCalledTimes(3)
    expect(mocks.collect).toHaveBeenCalledOnce()
  })

  test('does not rewrite local consent when only the online device inventory changes', async () => {
    mocks.enabled = false
    mocks.source = { ...(mocks.source as object), devices: [] }
    const view = render(<StandInTelemetryAgent />)
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledOnce())

    mocks.source = {
      ...(mocks.source as object),
      devices: [{ device_id: 'new-remote', status: 'online' }],
    }
    view.rerender(<StandInTelemetryAgent />)
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledWith(7, 'new-remote', false, 1234))
    expect(mocks.configure.mock.calls.filter(([, device]) => device === 'local')).toHaveLength(1)
  })

  test('shares an in-flight local policy write across an online device inventory change', async () => {
    let finish!: () => void
    mocks.configure.mockReturnValueOnce(
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    mocks.source = { ...(mocks.source as object), devices: [] }
    const view = render(<StandInTelemetryAgent />)
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledOnce())
    mocks.source = {
      ...(mocks.source as object),
      devices: [{ device_id: 'new-remote', status: 'online' }],
    }
    view.rerender(<StandInTelemetryAgent />)
    await act(async () => {})
    const localWrites = mocks.configure.mock.calls.filter(([, device]) => device === 'local').length
    await act(async () => finish())
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledWith(7, 'new-remote', true, 1234))
    expect(localWrites).toBe(1)
  })

  test('orders changed consent after an older in-flight policy write without collecting', async () => {
    let finish!: () => void
    mocks.configure.mockReturnValueOnce(
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    mocks.source = { ...(mocks.source as object), devices: [] }
    const view = render(<StandInTelemetryAgent />)
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledOnce())

    mocks.enabled = false
    view.rerender(<StandInTelemetryAgent />)
    await act(async () => {})
    const writesBeforePreviousCompletion = mocks.configure.mock.calls.length
    await act(async () => finish())
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(2))

    expect(writesBeforePreviousCompletion).toBe(1)
    expect(mocks.configure).toHaveBeenLastCalledWith(7, 'local', false, 1234)
    expect(mocks.collect).not.toHaveBeenCalled()
    expect(mocks.flush).not.toHaveBeenCalled()
  })
})
