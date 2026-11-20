import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { createPluginRecoveryNotice } from '@/components/plugins/workspace/pluginRecoveryNotice'
import type { PluginOperationNoticeState } from '@/components/plugins/PluginOperationNotice'
import { pluginMarketplaceCacheKey } from './pluginMarketplaceCache'
import {
  createLocalFirstPluginApi,
  deferredPluginRecoveryIds,
  PLUGIN_LOCAL_RECOVERY_OUTCOMES,
  PLUGIN_LOCAL_RECOVERY_REQUESTED,
} from './pluginLocalSync'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/desktop/localExecutor', () => ({ requestLocalExecutor: request }))
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const api = {} as Parameters<typeof createLocalFirstPluginApi>[0]

function localApi(token = 'fixture-token') {
  return createLocalFirstPluginApi(api, api, {
    apiBaseUrl: 'http://localhost:8000',
    token,
  })
}

describe('local plugin operation progress', () => {
  afterEach(() => {
    window.localStorage.clear()
    vi.useRealTimers()
    request.mockReset()
  })

  it('reports processing then confirmation without sending a second mutation', async () => {
    vi.useFakeTimers()
    let finish!: (value: { localCompleted: boolean }) => void
    const durableOperation = new Promise<{ localCompleted: boolean }>(resolve => {
      finish = resolve
    })
    request
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1, operationProgress: true })
      .mockReturnValueOnce(durableOperation)
      .mockResolvedValueOnce({ confirming: true })
    const report = vi.fn()
    const result = localApi().uninstallInstalledPlugin(10, undefined, report)

    await vi.advanceTimersByTimeAsync(999)
    expect(report).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(report.mock.calls).toEqual([['processing'], ['confirming']])
    const progressId = request.mock.calls[1][1].progressId
    expect(deferredPluginRecoveryIds()).toEqual([progressId])
    expect(request.mock.calls[2][1]).toMatchObject({ progressOnly: true, progressId })
    finish({ localCompleted: true })
    await result
    expect(deferredPluginRecoveryIds()).toEqual([])
    expect(report.mock.calls.at(-1)).toEqual(['settled'])
    expect(request.mock.calls.filter(([, params]) => params.action === 'uninstall')).toHaveLength(1)
  })

  it('keeps a pending update linked to its eventual recovery outcome', async () => {
    vi.useFakeTimers()
    let rejectUpdate!: (reason: unknown) => void
    const update = new Promise<never>((_resolve, reject) => {
      rejectUpdate = reject
    })
    request
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1, operationProgress: true })
      .mockReturnValueOnce(update)
      .mockResolvedValueOnce({ confirming: true })
    const wakeup = vi.fn()
    window.addEventListener(PLUGIN_LOCAL_RECOVERY_REQUESTED, wakeup, { once: true })
    const api = localApi()
    const report = vi.fn()
    const result = api.updateInstalledPlugin(10, { releaseId: 12 }, undefined, report)
    const error = result.catch((cause: unknown) => cause)
    await vi.advanceTimersByTimeAsync(1000)
    expect(report.mock.calls).toEqual([['processing'], ['confirming']])
    const { progressId } = request.mock.calls[1][1]
    expect(deferredPluginRecoveryIds()).toEqual([progressId])
    rejectUpdate({ code: 'plugin_local_confirmation_pending' })
    expect(await error).toMatchObject({ code: 'plugin_local_confirmation_pending', progressId })
    expect(deferredPluginRecoveryIds()).toEqual([progressId])
    expect(wakeup).toHaveBeenCalledOnce()

    const outcome = {
      operationId: 'native-operation',
      progressId,
      status: 'rejected',
      httpStatus: 403,
    }
    const reply = {
      enabled: true,
      protocolVersion: 1,
      operationProgress: true,
      pendingCount: 0,
      recoveryOutcomes: [outcome],
    }
    const scopeKey = pluginMarketplaceCacheKey('http://localhost:8000', 'fixture-token')
    let notice: PluginOperationNoticeState | null = null
    const reopened = createPluginRecoveryNotice({
      scopeKey: () => scopeKey,
      readNotice: () => notice,
      showNotice: next => {
        notice = next
        reopened.reconcile()
      },
      t: key => key,
    })
    const stop = reopened.subscribe()
    request.mockResolvedValueOnce(reply)
    await act(async () => {
      await localApi('other-account-token').supportsLocalSync()
    })
    expect(notice).toBeNull()
    expect(deferredPluginRecoveryIds()).toEqual([progressId])
    const observed = vi.fn()
    window.addEventListener(PLUGIN_LOCAL_RECOVERY_OUTCOMES, observed, { once: true })
    request.mockResolvedValueOnce(reply)
    await act(async () => {
      await localApi().supportsLocalSync()
    })
    expect(observed).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { scopeKey, outcomes: [outcome] } })
    )
    expect(notice).toMatchObject({
      id: `plugin-recovery-error-${progressId}`,
      kind: 'error',
      message: 'workbench.plugins_local_recovery_denied',
    })
    expect(deferredPluginRecoveryIds()).toEqual([])
    stop()
  })

  it('does not send a progress query to an executor without that capability', async () => {
    vi.useFakeTimers()
    let finish!: (value: { localCompleted: boolean }) => void
    const operation = new Promise<{ localCompleted: boolean }>(resolve => {
      finish = resolve
    })
    request
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1 })
      .mockReturnValueOnce(operation)
    const report = vi.fn()
    const result = localApi().uninstallInstalledPlugin(10, undefined, report)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(report.mock.calls).toEqual([['processing']])
    expect(request).toHaveBeenCalledTimes(2)
    finish({ localCompleted: true })
    await result
    expect(report.mock.calls.at(-1)).toEqual(['settled'])
  })
})
