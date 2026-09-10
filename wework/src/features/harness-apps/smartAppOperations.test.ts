import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation, HarnessAppPreview } from '@/api/local/harnessApps'
import type { SmartAppMarketplaceItem, SmartAppsApi } from '@/api/smartApps'
import { subscribeOperationResults, type OperationResult } from '@/telemetry/operationBus'
import {
  importSmartAppPackage,
  installMarketplaceSmartApp,
  prepareMarketplaceSmartApp,
} from './smartAppOperations'

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  install: vi.fn(),
  notify: vi.fn(),
  preview: vi.fn(),
}))

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    download: mocks.download,
    install: mocks.install,
    preview: mocks.preview,
  },
}))

vi.mock('./harnessAppInstallationsChanged', () => ({
  notifyHarnessAppInstallationsChanged: mocks.notify,
}))

const marketplaceItem = {
  id: 7,
  latestReleaseId: 17,
  name: 'research-desk',
} as SmartAppMarketplaceItem

const preview = {
  archivePath: '/private/research.zip',
  issues: [],
  manifest: {
    displayName: 'Research Desk',
    name: 'research-desk',
    version: '1.2.0',
  },
  sha256: 'a'.repeat(64),
  valid: true,
} as HarnessAppPreview

const installation = {
  id: 'installed-research',
  manifest: preview.manifest,
  source: 'market',
} as HarnessAppInstallation

function marketplaceApi() {
  return {
    getDownload: vi.fn().mockResolvedValue({
      downloadUrl: 'https://downloads.example.invalid/research.zip',
      releaseId: 17,
      sha256: preview.sha256,
      sizeBytes: 1024,
      smartAppId: 7,
    }),
  } as Pick<SmartAppsApi, 'getDownload'>
}

function collectOperationResults(): {
  listener: ReturnType<typeof vi.fn>
  results: OperationResult[]
  stop: () => void
} {
  const results: OperationResult[] = []
  const listener = vi.fn((result: OperationResult) => results.push(result))
  return {
    listener,
    results,
    stop: subscribeOperationResults(listener),
  }
}

describe('smart app operations', () => {
  beforeEach(() => {
    mocks.download.mockReset().mockResolvedValue(preview)
    mocks.install.mockReset().mockResolvedValue(installation)
    mocks.notify.mockReset()
    mocks.preview.mockReset().mockResolvedValue(preview)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('reports install success only after the local installation is confirmed', async () => {
    const events = collectOperationResults()
    const prepared = await prepareMarketplaceSmartApp(marketplaceApi(), marketplaceItem, 'install')

    await expect(installMarketplaceSmartApp(prepared, 'model-1')).resolves.toBe(installation)

    expect(events.results).toEqual([
      expect.objectContaining({
        context: {
          smartApp: {
            key: 'research-desk',
            name: 'Research Desk',
            source: 'market',
            version: '1.2.0',
          },
        },
        key: 'smart_app.install',
        outcome: 'succeeded',
      }),
    ])
    expect(mocks.notify.mock.invocationCallOrder[0]).toBeLessThan(
      events.listener.mock.invocationCallOrder[0]!
    )
    events.stop()
  })

  test('uses the update operation instead of installation', async () => {
    const events = collectOperationResults()
    const prepared = await prepareMarketplaceSmartApp(marketplaceApi(), marketplaceItem, 'update')

    await installMarketplaceSmartApp(prepared, 'model-1')

    expect(events.results).toEqual([
      expect.objectContaining({ key: 'smart_app.update', outcome: 'succeeded' }),
    ])
    events.stop()
  })

  test('reports a marketplace download failure without leaking download details', async () => {
    const api = marketplaceApi()
    api.getDownload.mockRejectedValue(new Error('private download failure'))
    const events = collectOperationResults()

    await expect(prepareMarketplaceSmartApp(api, marketplaceItem, 'install')).rejects.toThrow(
      'private download failure'
    )

    expect(events.results).toEqual([
      { failureStage: 'download', key: 'smart_app.install', outcome: 'failed' },
    ])
    events.stop()
  })

  test('reports marketplace validation and install failures at their service boundaries', async () => {
    mocks.download.mockResolvedValue({ ...preview, manifest: null, valid: false })
    const validationEvents = collectOperationResults()

    await expect(
      prepareMarketplaceSmartApp(marketplaceApi(), marketplaceItem, 'update')
    ).rejects.toThrow('Invalid Smart App package')

    expect(validationEvents.results).toEqual([
      { failureStage: 'validate', key: 'smart_app.update', outcome: 'failed' },
    ])
    validationEvents.stop()

    mocks.download.mockResolvedValue(preview)
    mocks.install.mockRejectedValue(new Error('private installation failure'))
    const installEvents = collectOperationResults()
    const prepared = await prepareMarketplaceSmartApp(marketplaceApi(), marketplaceItem, 'install')

    await expect(installMarketplaceSmartApp(prepared, 'model-1')).rejects.toThrow(
      'private installation failure'
    )

    expect(installEvents.results).toEqual([
      { failureStage: 'install', key: 'smart_app.install', outcome: 'failed' },
    ])
    expect(JSON.stringify(installEvents.results)).not.toContain('private')
    installEvents.stop()
  })

  test('reports confirmation failure after an installation notification cannot be published', async () => {
    mocks.notify.mockImplementation(() => {
      throw new Error('notification unavailable')
    })
    const events = collectOperationResults()
    const prepared = await prepareMarketplaceSmartApp(marketplaceApi(), marketplaceItem, 'install')

    await expect(installMarketplaceSmartApp(prepared, 'model-1')).rejects.toThrow(
      'notification unavailable'
    )

    expect(events.results).toEqual([
      expect.objectContaining({
        failureStage: 'confirm',
        key: 'smart_app.install',
        outcome: 'failed',
      }),
    ])
    events.stop()
  })

  test('maps an invalid ZIP preview to a validation failure without private details', async () => {
    mocks.preview.mockResolvedValue({
      ...preview,
      issues: ['private validation detail'],
      valid: false,
    })
    const events = collectOperationResults()

    await expect(importSmartAppPackage('/private/workbench.zip')).rejects.toThrow(
      'Invalid Smart App package'
    )

    expect(events.results).toEqual([
      { failureStage: 'validate', key: 'smart_app.zip_import', outcome: 'failed' },
    ])
    expect(JSON.stringify(events.results)).not.toContain('private')
    events.stop()
  })

  test('maps ZIP preview failures to the preview stage', async () => {
    mocks.preview.mockRejectedValue(new Error('private preview failure'))
    const events = collectOperationResults()

    await expect(importSmartAppPackage('/private/workbench.zip')).rejects.toThrow(
      'private preview failure'
    )

    expect(events.results).toEqual([
      { failureStage: 'preview', key: 'smart_app.zip_import', outcome: 'failed' },
    ])
    events.stop()
  })
})
