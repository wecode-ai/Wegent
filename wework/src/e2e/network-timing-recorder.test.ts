import { afterEach, expect, test, vi } from 'vitest'
import { createNetworkTimingRecorder } from './network-timing-recorder'

afterEach(() => vi.unstubAllGlobals())

test('retains recent requests beyond the browser resource buffer and drains pending deliveries', () => {
  let deliver!: PerformanceObserverCallback
  const observe = vi.fn()
  const takeRecords = vi.fn((): PerformanceEntry[] => [])
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      constructor(callback: PerformanceObserverCallback) {
        deliver = callback
      }
      observe = observe
      takeRecords = takeRecords
    }
  )
  const read = createNetworkTimingRecorder()
  expect(observe).toHaveBeenCalledWith({ type: 'resource', buffered: true })
  const entry = (index: number) =>
    ({
      name: `https://example.test/rpc/${index}?token=private#private`,
      startTime: index,
      duration: 4000,
      fetchStart: index,
      requestStart: index + 3000,
      responseStart: index + 3990,
      responseEnd: index + 4000,
    }) as PerformanceResourceTiming
  const deliverEntries = (entries: PerformanceEntry[]) =>
    deliver(
      { getEntries: () => entries } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    )

  deliverEntries(Array.from({ length: 250 }, (_, index) => entry(index)))
  deliverEntries(Array.from({ length: 250 }, (_, index) => entry(index + 250)))
  takeRecords.mockReturnValueOnce([entry(500)])
  const result = read()
  expect(result).toHaveLength(250)
  expect(result[0].path).toBe('/rpc/251')
  expect(result.at(-1)).toMatchObject({
    path: '/rpc/500',
    fetchStart: 500,
    requestStart: 3500,
    responseStart: 4490,
    responseEnd: 4500,
  })
  expect(JSON.stringify(result)).not.toContain('private')
  result.length = 0
  expect(read()).toHaveLength(250)
})
