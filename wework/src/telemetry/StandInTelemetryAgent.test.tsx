import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
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
  mocks.identity.mockResolvedValue({ deviceId: 'local' })
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
})
