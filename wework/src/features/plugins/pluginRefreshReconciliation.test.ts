// @vitest-environment node

import type { InstalledPlugin, PluginDeviceSyncResponse } from '@/types/api'
import { describe, expect, test, vi } from 'vitest'
import {
  reconcilePluginRefresh,
  verifyReconciledPluginInventory,
} from './pluginRefreshReconciliation'

function plugin(id: number, enabled = true): InstalledPlugin {
  return {
    metadata: { labels: { id } },
    spec: { enabled, sourcePayload: { managedByWegent: true, cloudInstalledPluginId: id } },
  } as InstalledPlugin
}

function operations() {
  return {
    isCurrent: vi.fn(() => true),
    readStore: vi.fn(async () => [plugin(12)]),
    readCloud: vi.fn(async () => [plugin(12)]),
    sync: vi.fn(
      async () =>
        ({
          reconciled: true,
          sync: {
            success: true,
            failed: 0,
            errors: [],
            plugins: [],
          },
        }) as PluginDeviceSyncResponse
    ),
    invalidate: vi.fn(),
  }
}

describe('plugin refresh reconciliation', () => {
  test('reports stages only as real operations advance', async () => {
    const ops = operations()
    const stages: string[] = []
    let release!: () => void
    ops.sync.mockImplementation(async () => {
      expect(stages).toEqual(['reading', 'syncing'])
      await new Promise<void>(resolve => {
        release = resolve
      })
      return {
        reconciled: true,
        sync: { success: true, failed: 0, errors: [], plugins: [] },
      } as unknown as PluginDeviceSyncResponse
    })
    const result = reconcilePluginRefresh({ ...ops, onProgress: stage => stages.push(stage) })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(stages).toEqual(['reading', 'syncing'])
    release()
    await result
    expect(stages).toEqual(['reading', 'syncing', 'verifying'])
  })

  test('stops progress and mutations if the account changes during the inventory read', async () => {
    const ops = operations()
    const onProgress = vi.fn()
    ops.readStore.mockImplementation(async () => {
      ops.isCurrent.mockReturnValue(false)
      return [plugin(12)]
    })
    await reconcilePluginRefresh({ ...ops, onProgress })
    expect(onProgress).toHaveBeenCalledExactlyOnceWith('reading')
    expect(ops.sync).not.toHaveBeenCalled()
    expect(ops.invalidate).not.toHaveBeenCalled()
  })

  test('does not report success for HTTP success with failed device synchronization', async () => {
    const ops = operations()
    ops.sync.mockResolvedValue({
      reconciled: true,
      sync: { success: false, failed: 1, errors: [], plugins: [] },
    } as unknown as PluginDeviceSyncResponse)
    await expect(reconcilePluginRefresh(ops)).rejects.toThrow('did not complete')
    expect(ops.invalidate).not.toHaveBeenCalled()
  })
  test('does not use an empty fallback when the cloud read fails', async () => {
    const ops = operations()
    ops.readCloud.mockRejectedValue(new Error('network unavailable'))
    await expect(reconcilePluginRefresh(ops)).rejects.toThrow('network unavailable')
  })
  test('rejects missing, duplicate and orphan installations but accepts disabled ones', () => {
    const unidentified = plugin(12)
    unidentified.metadata.labels = {}
    unidentified.spec.sourcePayload = {}
    expect(() => verifyReconciledPluginInventory([unidentified], [unidentified])).toThrow()
    expect(() => verifyReconciledPluginInventory([plugin(12)], [])).toThrow()
    expect(() => verifyReconciledPluginInventory([], [plugin(12)])).toThrow()
    expect(() => verifyReconciledPluginInventory([plugin(12)], [plugin(12), plugin(12)])).toThrow()
    expect(() => verifyReconciledPluginInventory([plugin(12, false)], [plugin(12)])).toThrow()
    expect(() =>
      verifyReconciledPluginInventory([plugin(12, false)], [plugin(12, false)])
    ).not.toThrow()
  })
  test('discards the old account result before cache invalidation or repaint', async () => {
    const ops = operations()
    ops.isCurrent.mockReturnValueOnce(true).mockReturnValue(false)
    await reconcilePluginRefresh(ops)
    expect(ops.invalidate).not.toHaveBeenCalled()
    expect(ops.readCloud).not.toHaveBeenCalled()
  })
})
