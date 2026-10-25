import { afterEach, describe, expect, test, vi } from 'vitest'
import { createHttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import { createLocalDevicePluginApi } from './pluginDeviceApi'

const deviceId = 'electron-plugins'
const requestId = 'app-record-70'
const wireDevices = [
  { deviceId: requestId, state: 'installed', actualReleaseId: 1002 },
  { deviceId: 'other-device', state: 'failed', actualReleaseId: 1001 },
]
const installed = { metadata: { name: 'documents' }, status: { devices: wireDevices } }
const sync = {
  device_id: requestId,
  success: false,
  mode: 'replace',
  skills: [],
  mcps: [],
  plugins: [{ id: 101, status: 'failed', stage: 'checksum', error_code: 'CHECKSUM_MISMATCH' }],
  errors: [{ error: 'Checksum mismatch' }],
  synced: 0,
  failed: 1,
  skipped: 0,
  results: [
    { device_id: requestId, success: false, error: 'Checksum mismatch' },
    { device_id: 'other-device', success: true },
  ],
}

afterEach(() => vi.unstubAllGlobals())

function apiWithResponse(response: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
  return createLocalDevicePluginApi(
    createPluginApi(createHttpClient({ baseUrl: '/api', getToken: () => null })),
    () => requestId
  )
}

describe('local plugin device API boundary', () => {
  test('maps route-addressed inventory status while preserving other devices', async () => {
    const api = apiWithResponse({ items: [installed] })

    const response = await api.listInstalledPlugins(deviceId)

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed?device_id=app-record-70',
      expect.objectContaining({ method: 'GET' })
    )
    expect(response.items[0].status.devices).toEqual([
      { ...wireDevices[0], deviceId },
      wireDevices[1],
    ])
    expect(wireDevices[0].deviceId).toBe(requestId)
  })

  test('keeps unscoped account inventory unscoped', async () => {
    const api = apiWithResponse({ items: [installed] })

    const response = await api.listInstalledPlugins()

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed',
      expect.objectContaining({ method: 'GET' })
    )
    expect(response.items[0].status.devices).toEqual(wireDevices)
  })

  test('maps the marketplace device state without changing catalog fields', async () => {
    const item = { id: 101, name: 'documents', currentDeviceInstallation: wireDevices[0] }
    const api = apiWithResponse({ items: [item] })

    const response = await api.listMarketplacePlugins({ q: 'documents', deviceId })

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/marketplace?q=documents&device_id=app-record-70',
      expect.objectContaining({ method: 'GET' })
    )
    expect(response.items).toEqual([
      { ...item, currentDeviceInstallation: { ...wireDevices[0], deviceId } },
    ])
  })

  test.each(['marketplace', 'builtin'] as const)(
    'maps the %s install acknowledgement and preserves sync failure details',
    async source => {
      const api = apiWithResponse({ plugin: installed, sync })

      const response =
        source === 'marketplace'
          ? await api.installMarketplacePlugin(101, deviceId)
          : await api.ensureBuiltinPluginInstalled('documents', { deviceId })

      const expectedUrl =
        source === 'marketplace'
          ? '/api/plugins/marketplace/101/install?device_id=app-record-70'
          : '/api/plugins/builtin/documents/ensure-installed'
      expect(fetch).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          method: 'POST',
          ...(source === 'builtin' ? { body: JSON.stringify({ device_id: requestId }) } : {}),
        })
      )
      expect(response.plugin.status.devices?.[0].deviceId).toBe(deviceId)
      expect(response.sync).toEqual({
        ...sync,
        device_id: deviceId,
        results: [{ ...sync.results[0], device_id: deviceId }, sync.results[1]],
      })
    }
  )

  test.each(['single', 'reconcile'] as const)(
    'maps only the current Runtime in a %s sync response',
    async operation => {
      const api = apiWithResponse({ deviceId: requestId, pendingCount: 1, sync })

      const response =
        operation === 'single'
          ? await api.syncInstalledPluginToDevice(101, deviceId)
          : await api.syncInstalledPluginsToDevice(deviceId, true)

      expect(fetch).toHaveBeenCalledWith(
        operation === 'single'
          ? '/api/plugins/installed/101/sync-device?device_id=app-record-70'
          : '/api/plugins/installed/sync-device?device_id=app-record-70&reconcile=true',
        expect.objectContaining({ method: 'POST' })
      )
      expect(response.deviceId).toBe(deviceId)
      expect(response.sync).toEqual({
        ...sync,
        device_id: deviceId,
        results: [{ ...sync.results[0], device_id: deviceId }, sync.results[1]],
      })
    }
  )

  test('maps a device status acknowledgement without changing the acknowledged plugin IDs', async () => {
    const api = apiWithResponse({
      deviceId: requestId,
      acknowledgedCount: 1,
      acknowledgedInstalledPluginIds: [101],
    })
    const reports = [{ installedPluginId: 101, releaseId: 1002, version: '1.1.0' }]

    const response = await api.reportInstalledPluginsOnDevice(deviceId, reports)

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/report-device?device_id=app-record-70',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ plugins: reports }) })
    )
    expect(response).toEqual({
      deviceId,
      acknowledgedCount: 1,
      acknowledgedInstalledPluginIds: [101],
    })
  })
})
