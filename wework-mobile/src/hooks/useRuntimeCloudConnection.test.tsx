import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStream, CloudConnectionSnapshot } from '@/services/runtimeStream'
import { useRuntimeCloudConnection } from './useRuntimeCloudConnection'
import { useRuntimeFailures } from './useRuntimeFailures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
describe('independent cloud connection and reads', () => {
  let renderer: ReactTestRenderer
  let state: ReturnType<typeof useRuntimeCloudConnection> & ReturnType<typeof useRuntimeFailures>
  let connection: CloudConnectionSnapshot
  const listDevices = vi.fn()
  const listModels = vi.fn()
  const applyDevices = vi.fn(() => 'remote')
  const applyModels = vi.fn()
  const initial = vi.fn()
  const reconnect = vi.fn(async () => {})
  const stream = {
    getCloudConnection: () => connection,
    reconnectCloud: reconnect,
  } as unknown as RuntimeStream
  function Harness({ identity = 'account-a' }: { identity?: string | null }) {
    const failures = useRuntimeFailures()
    state = {
      ...failures,
      ...useRuntimeCloudConnection({
        api: { listDevices, listModels },
        stream,
        identity,
        connection,
        cacheReady: true,
        applyDevices,
        applyModels,
        onInitialDevices: initial,
        ...failures,
      }),
    }
    return null
  }
  beforeEach(() => {
    vi.clearAllMocks()
    listDevices.mockReset().mockResolvedValue({ items: [] })
    listModels.mockReset().mockResolvedValue({ data: [] })
    connection = { connected: false, error: null }
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  async function mount() {
    await act(() => {
      renderer = create(<Harness />)
    })
  }
  async function connect(connected: boolean) {
    connection = { connected, error: null }
    await act(() => renderer.update(<Harness />))
  }
  it('gates initial cloud reads on connection and never refreshes them on reconnect', async () => {
    await mount()
    expect(listDevices).not.toHaveBeenCalled()
    expect(listModels).not.toHaveBeenCalled()
    expect(state.failures.map(item => item.id)).toEqual(['cloud-connection'])
    await act(() => state.retryFailure(state.failures[0]!))
    expect(reconnect).toHaveBeenCalledOnce()
    expect(listDevices).not.toHaveBeenCalled()
    await connect(true)
    expect(listDevices).toHaveBeenCalledOnce()
    expect(listModels).toHaveBeenCalledOnce()
    expect(initial).toHaveBeenCalledOnce()
    expect(state.failures).toEqual([])
    await connect(false)
    await connect(true)
    expect(listDevices).toHaveBeenCalledOnce()
    expect(listModels).toHaveBeenCalledOnce()
    expect(initial).toHaveBeenCalledOnce()
  })
  it('loads devices while models are pending and retries discovery without reading models or work', async () => {
    const models = deferred<{ data: [] }>()
    listModels.mockReturnValue(models.promise)
    listDevices.mockRejectedValueOnce(new Error('device discovery failed'))
    connection = { connected: true, error: null }
    await mount()
    expect(state.failures.map(item => item.id)).toEqual(['cloud-devices'])
    await act(() => state.retryFailure(state.failures[0]!))
    expect(listDevices).toHaveBeenCalledTimes(2)
    expect(listModels).toHaveBeenCalledOnce()
    expect(initial).not.toHaveBeenCalled()
    expect(state.failures).toEqual([])
    await act(() => models.resolve({ data: [] }))
    expect(applyModels).toHaveBeenCalledOnce()
  })
  it('ignores older discovery and responses from a previous login to the same account', async () => {
    const old = deferred<{ items: [] }>()
    listDevices.mockReturnValueOnce(old.promise)
    connection = { connected: true, error: null }
    await mount()
    await act(async () => {
      await state.refreshDevices()
    })
    expect(applyDevices).toHaveBeenCalledOnce()
    await act(() => renderer.update(<Harness identity={null} />))
    await act(() => renderer.update(<Harness />))
    expect(listDevices).toHaveBeenCalledTimes(3)
    expect(initial).toHaveBeenCalledOnce()
    await act(() => old.resolve({ items: [] }))
    expect(applyDevices).toHaveBeenCalledTimes(2)
    expect(initial).toHaveBeenCalledOnce()
  })
})
