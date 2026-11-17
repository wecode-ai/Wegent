import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedModel } from '@/types/api'
import { createModelCatalog } from './modelCatalog'
import { createModelApi } from '@wegent/chat-core/model-api'

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
})

describe.each(['local', 'cloud'] as const)('%s on-demand model catalog', source => {
  it('refreshes through a new HTTP request after the shared model API stalls', async () => {
    let resolveOld!: (value: { data: UnifiedModel[] }) => void
    const client = {
      get: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              resolveOld = resolve
            })
        )
        .mockResolvedValue({ data: [cloudModel] }),
    }
    const api = createModelApi(client)
    const catalog = createModelCatalog(source, async (signal, forceRefresh) => {
      const response = await api.listModels({ signal, forceRefresh })
      return response.data
    })
    disposers.push(catalog.subscribe(vi.fn()))
    catalog.loadIfNeeded()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.get.mock.calls[0][1].signal.aborted).toBe(true)
    catalog.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.get).toHaveBeenCalledTimes(2)
    expect(catalog.getModels()).toEqual([cloudModel])
    resolveOld({ data: [{ name: 'stale-model', type: 'public' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([cloudModel])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not poll or retry a failed initial load until explicitly refreshed', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([cloudModel])
    const catalog = createModelCatalog(source, load)
    const changed = vi.fn()
    disposers.push(catalog.subscribe(changed))
    catalog.loadIfNeeded()
    await vi.advanceTimersByTimeAsync(0)
    catalog.loadIfNeeded()
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(600_000)
    expect(load).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    catalog.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([cloudModel])
    expect(load).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('waits for initial discovery but exposes the last snapshot during a pending refresh', async () => {
    let finish!: (models: UnifiedModel[]) => void
    const load = vi.fn(() => new Promise<UnifiedModel[]>(resolve => (finish = resolve)))
    const catalog = createModelCatalog(source, load)
    disposers.push(catalog.subscribe(vi.fn()))
    const initialRead = vi.fn()
    catalog.loadIfNeeded().then(initialRead)
    await vi.advanceTimersByTimeAsync(0)
    expect(initialRead).not.toHaveBeenCalled()
    finish([cloudModel])
    await vi.advanceTimersByTimeAsync(0)
    expect(initialRead).toHaveBeenCalledOnce()

    catalog.refresh()
    const refreshRead = vi.fn()
    catalog.loadIfNeeded().then(refreshRead)
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshRead).toHaveBeenCalledOnce()
    expect(catalog.getModels()).toEqual([cloudModel])
    expect(load).toHaveBeenCalledTimes(2)
    finish([])
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([])
  })

  it('retains existing models on failure and updates them on the next refresh', async () => {
    const replacement: UnifiedModel = { name: 'new-cloud-model', type: 'public' }
    const load = vi
      .fn()
      .mockResolvedValueOnce([cloudModel])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([cloudModel, replacement])
    const catalog = createModelCatalog(source, load)
    const changed = vi.fn()
    disposers.push(catalog.subscribe(changed))
    catalog.loadIfNeeded()
    await vi.advanceTimersByTimeAsync(0)
    catalog.refresh()
    expect(catalog.getModels()).toEqual([cloudModel])
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([cloudModel])
    expect(changed).toHaveBeenCalledOnce()
    catalog.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([cloudModel, replacement])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('refreshes a cached empty result and applies successful removals', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([cloudModel])
      .mockResolvedValue([])
    const catalog = createModelCatalog(source, load)
    disposers.push(catalog.subscribe(vi.fn()))
    catalog.loadIfNeeded()
    await vi.advanceTimersByTimeAsync(0)
    catalog.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([cloudModel])
    catalog.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([])
  })

  it('coalesces concurrent refreshes and cancels when the last consumer leaves', async () => {
    const load = vi
      .fn<(signal: AbortSignal) => Promise<UnifiedModel[]>>()
      .mockReturnValue(new Promise(() => undefined))
    const catalog = createModelCatalog(source, load)
    const unsubscribeFirst = catalog.subscribe(vi.fn())
    const unsubscribeSecond = catalog.subscribe(vi.fn())
    disposers.push(unsubscribeFirst, unsubscribeSecond)
    catalog.loadIfNeeded()
    catalog.refresh()
    catalog.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledOnce()
    unsubscribeFirst()
    expect(load.mock.calls[0][0].aborted).toBe(false)
    unsubscribeSecond()
    expect(load.mock.calls[0][0].aborted).toBe(true)
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
    const catalog = createModelCatalog(source, load)
    const unsubscribe = catalog.subscribe(vi.fn())
    catalog.loadIfNeeded()
    await vi.advanceTimersByTimeAsync(0)
    unsubscribe()
    const changed = vi.fn()
    disposers.push(catalog.subscribe(changed))
    catalog.loadIfNeeded()
    await vi.advanceTimersByTimeAsync(0)
    resolveOld([{ name: 'stale-model', type: 'public' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(catalog.getModels()).toEqual([cloudModel])
    expect(changed).toHaveBeenCalledOnce()
  })
})
