import { afterEach, expect, test, vi } from 'vitest'
import { logPluginRefreshPhase } from './pluginRefreshDiagnostics'
import {
  beginPluginDeviceSync,
  clearPluginDeviceAutoSyncAttempts,
  pluginDeviceSyncDiagnostic,
} from './pluginDeviceAutoSync'

vi.mock('@/lib/performanceDiagnostics', () => ({ isPerformanceDiagnosticsEnabled: () => false }))
afterEach(() => {
  clearPluginDeviceAutoSyncAttempts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('ordinary user paths do not emit phase logs', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  logPluginRefreshPhase('reconcile-start', { request: 2 })
  const release = beginPluginDeviceSync('private-device', 'policy')!
  release()
  expect(log).not.toHaveBeenCalled()
})

test('isolated diagnostics identify the owning lease and release without including raw source data', () => {
  vi.stubGlobal('__WEWORK_E2E__', {})
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const release = beginPluginDeviceSync('private-device', 'policy')!
  const held = pluginDeviceSyncDiagnostic('private-device')
  expect(held).toMatchObject({ owner: 'policy', lease: expect.any(Number) })
  expect(beginPluginDeviceSync('private-device', 'reconcile')).toBeNull()
  expect(pluginDeviceSyncDiagnostic('private-device').lease).toBe(held.lease)
  release()
  expect(pluginDeviceSyncDiagnostic('private-device')).toEqual({})
  logPluginRefreshPhase('test', {
    ...held,
    privateText: 'DO_NOT_LOG',
  } as Parameters<typeof logPluginRefreshPhase>[1])
  const events = log.mock.calls.map(call => JSON.parse(String(call[1])))
  expect(events.slice(0, 2).map(event => event.phase)).toEqual(['lease-acquired', 'lease-released'])
  expect(events[1]).toMatchObject({
    owner: 'policy',
    lease: held.lease,
    elapsedMs: expect.any(Number),
  })
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-device|DO_NOT_LOG/)
})
