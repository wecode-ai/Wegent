import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedModel } from '@/types/api'
import { createCloudModelCatalog } from './cloudModelCatalog'

const cloudModel: UnifiedModel = { name: 'cloud-model', type: 'public' }
const disposers: (() => void)[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete window.weworkElectronLifecycle
})

describe('cloud model catalog recovery', () => {
  it('automatically retries transient failures with capped backoff', async () => {
    const load = vi.fn().mockRejectedValue(new Error('offline'))
    const catalog = createCloudModelCatalog(load)
    const changed = vi.fn()
    disposers.push(catalog.subscribe(changed))
    await vi.advanceTimersByTimeAsync(0)

    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const attempts = load.mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(load).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(load).toHaveBeenCalledTimes(attempts + 1)
    }
    expect(changed).not.toHaveBeenCalled()
    load.mockResolvedValue([cloudModel])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(catalog.getModels()).toEqual([cloudModel])
    expect(changed).toHaveBeenCalledOnce()
  })

  it('aborts a stalled request and retries without a user action', async () => {
    let signal!: AbortSignal
    const load = vi.fn<(signal: AbortSignal) => Promise<UnifiedModel[]>>()
    load.mockImplementationOnce(requestSignal => {
      signal = requestSignal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    load.mockResolvedValue([cloudModel])
    const catalog = createCloudModelCatalog(load)
    disposers.push(catalog.subscribe(vi.fn()))
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(signal.aborted).toBe(true)
    expect(signal.reason.name).toBe('TimeoutError')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(2)
    expect(catalog.getModels()).toEqual([cloudModel])
  })

  it('retains a loaded catalog on refresh failure and applies a later recovery', async () => {
    const replacement: UnifiedModel = { name: 'new-cloud-model', type: 'public' }
    const load = vi
      .fn()
      .mockResolvedValueOnce([cloudModel])
      .mockRejectedValueOnce(new Error('network interrupted'))
      .mockResolvedValue([cloudModel, replacement])
    const catalog = createCloudModelCatalog(load)
    const changed = vi.fn()
    disposers.push(catalog.subscribe(changed))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(catalog.getModels()).toEqual([cloudModel])
    expect(changed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(catalog.getModels()).toEqual([cloudModel, replacement])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('revalidates an empty catalog and applies authoritative removals', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([cloudModel])
      .mockResolvedValue([])
    const catalog = createCloudModelCatalog(load)
    disposers.push(catalog.subscribe(vi.fn()))
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(catalog.getModels()).toEqual([cloudModel])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(catalog.getModels()).toEqual([])
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('shares one refresh loop and cancels it when the last consumer leaves', async () => {
    const load = vi.fn().mockResolvedValue([cloudModel])
    const catalog = createCloudModelCatalog(load)
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = catalog.subscribe(first)
    const unsubscribeSecond = catalog.subscribe(second)
    disposers.push(unsubscribeFirst, unsubscribeSecond)
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledOnce()
    unsubscribeFirst()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledTimes(2)
    unsubscribeSecond()
    await vi.advanceTimersByTimeAsync(120_000)
    window.dispatchEvent(new Event('online'))
    expect(load).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores late results from cancelled subscriptions', async () => {
    let resolveOld!: (models: UnifiedModel[]) => void
    const load = vi
      .fn<(signal: AbortSignal) => Promise<UnifiedModel[]>>()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveOld = resolve
          })
      )
      .mockResolvedValue([cloudModel])
    const catalog = createCloudModelCatalog(load)
    const unsubscribe = catalog.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    unsubscribe()
    expect(load.mock.calls[0][0].aborted).toBe(true)
    const changed = vi.fn()
    disposers.push(catalog.subscribe(changed))
    await vi.advanceTimersByTimeAsync(0)
    resolveOld([{ name: 'stale-model', type: 'public' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([cloudModel])
    expect(changed).toHaveBeenCalledOnce()
  })

  it('refreshes immediately after reconnection or system resume', async () => {
    let resume!: () => void
    const unsubscribeResume = vi.fn()
    window.weworkElectronLifecycle = {
      onSystemResume: listener => {
        resume = listener
        return unsubscribeResume
      },
    }
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([cloudModel])
    const catalog = createCloudModelCatalog(load)
    const unsubscribe = catalog.subscribe(vi.fn())
    disposers.push(unsubscribe)
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([cloudModel])
    resume()
    resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(3)
    unsubscribe()
    expect(unsubscribeResume).toHaveBeenCalledOnce()
  })
})
