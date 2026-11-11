// @vitest-environment node

import { subscribeOperationResults, type OperationResult } from '@/telemetry/operationBus'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { harnessAppsApi } from './harnessApps'

const mocks = vi.hoisted(() => ({
  businessTrack: vi.fn(),
  desktopInvoke: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: (...args: unknown[]) => mocks.desktopInvoke(...args),
}))

vi.mock('@/telemetry/businessEvents', () => ({
  trackBusinessEvent: (...args: unknown[]) => mocks.businessTrack(...args),
}))

describe('harnessAppsApi', () => {
  beforeEach(() => {
    mocks.businessTrack.mockReset()
    mocks.desktopInvoke.mockReset()
  })

  test('reports the runtime response rather than treating a resolved failed start as success', async () => {
    const results: OperationResult[] = []
    const stop = subscribeOperationResults(result => results.push(result))
    try {
      const failed = { state: 'failed', error: 'private runtime error' }
      mocks.desktopInvoke.mockResolvedValueOnce(failed).mockResolvedValueOnce({ state: 'running' })
      await expect(harnessAppsApi.start({ installationId: 'private-app' })).resolves.toBe(failed)
      await harnessAppsApi.start({ installationId: 'private-app' })
      const firstStartupId = mocks.businessTrack.mock.calls[0]?.[1]?.startup_id
      const secondStartupId = mocks.businessTrack.mock.calls[1]?.[1]?.startup_id
      expect(firstStartupId).toMatch(/^[0-9a-f-]{36}$/)
      expect(secondStartupId).toMatch(/^[0-9a-f-]{36}$/)
      expect(firstStartupId).not.toBe(secondStartupId)
      expect(mocks.businessTrack.mock.calls).toEqual([
        ['smart_app_start_attempted', { startup_id: firstStartupId }],
        ['smart_app_start_attempted', { startup_id: secondStartupId }],
      ])
      expect(results).toEqual([
        {
          key: 'smart_app.start',
          outcome: 'failed',
          failureStage: 'confirm',
          properties: { startup_id: firstStartupId },
        },
        {
          key: 'smart_app.start',
          outcome: 'succeeded',
          properties: { startup_id: secondStartupId },
        },
      ])
    } finally {
      stop()
    }
  })

  test('uses the Host open contract without renderer tokens', async () => {
    await harnessAppsApi.open('workbench', 'window')
    expect(mocks.desktopInvoke).toHaveBeenCalledWith('smartApps.open', {
      installationId: 'workbench',
      presentation: 'window',
    })
    await harnessAppsApi.start({ installationId: 'workbench' })
    expect(mocks.desktopInvoke).toHaveBeenLastCalledWith('smartApps.start', {
      installationId: 'workbench',
    })
  })

  test('positions the existing Host surface without requesting another page', async () => {
    const bounds = { x: 12, y: 38, width: 800, height: 600 }
    await harnessAppsApi.layout('workbench', bounds, true)
    expect(mocks.desktopInvoke).toHaveBeenCalledWith('smartApps.layout', {
      installationId: 'workbench',
      bounds,
      visible: true,
    })
  })

  test('prepares a development runtime through the preview-only Host entry', async () => {
    await harnessAppsApi.preparePreview('workbench')
    expect(mocks.desktopInvoke).toHaveBeenCalledExactlyOnceWith('smartApps.preparePreview', {
      installationId: 'workbench',
    })
  })

  test('returns cancelled native copy approval without reporting success', async () => {
    const results: OperationResult[] = []
    const stop = subscribeOperationResults(result => results.push(result))
    try {
      mocks.desktopInvoke.mockResolvedValueOnce(null)
      await expect(
        harnessAppsApi.copyToDirectory('market-7', {
          parentPath: '/tmp',
          name: 'copied-workbench',
          displayName: 'Copied workbench',
        })
      ).resolves.toBeNull()
      expect(results).toEqual([
        { key: 'smart_app.copy', outcome: 'failed', failureStage: 'confirm' },
      ])
    } finally {
      stop()
    }
  })

  test('keeps background policy independent of startup and presentation', async () => {
    await harnessAppsApi.configure('workbench', { background: false })
    expect(mocks.desktopInvoke).toHaveBeenCalledWith('smartApps.configure', {
      installationId: 'workbench',
      background: false,
    })
  })

  test('passes the selected capability template when creating a Smart App', async () => {
    mocks.desktopInvoke.mockResolvedValue({})

    await harnessAppsApi.createDirectory({
      parentPath: '/tmp',
      name: 'contract-app',
      displayName: 'Contract App',
      description: 'Generic app',
      template: 'web-host-remote',
      flavor: 'extended',
    })

    expect(mocks.desktopInvoke).toHaveBeenCalledWith('smartApps.createDirectory', {
      parentPath: '/tmp',
      name: 'contract-app',
      displayName: 'Contract App',
      description: 'Generic app',
      template: 'web-host-remote',
      flavor: 'extended',
    })
  })
})
