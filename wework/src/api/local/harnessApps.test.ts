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
      await expect(
        harnessAppsApi.start({ installationId: 'private-app', modelBaseUrl: null })
      ).resolves.toBe(failed)
      await harnessAppsApi.start({ installationId: 'private-app', modelBaseUrl: null })
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

  test('passes the selected capability template when creating a Smart App', async () => {
    mocks.desktopInvoke.mockResolvedValue({})

    await harnessAppsApi.createDirectory({
      parentPath: '/tmp',
      name: 'contract-app',
      displayName: 'Contract App',
      description: 'Generic app',
      template: 'web-host-remote',
    })

    expect(mocks.desktopInvoke).toHaveBeenCalledWith('smartApps.createDirectory', {
      parentPath: '/tmp',
      name: 'contract-app',
      displayName: 'Contract App',
      description: 'Generic app',
      template: 'web-host-remote',
    })
  })
})
