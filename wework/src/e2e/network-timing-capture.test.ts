import { afterEach, expect, test, vi } from 'vitest'
import * as desktopHost from '@/api/dsh/desktopHost'
import { runDesktopControlClient } from './automation'
import { createNetworkTimingCapture } from './network-timing-capture'

class ResourceObserver {
  static latest: ResourceObserver
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()
  records: PerformanceEntry[] = []

  constructor(readonly callback: PerformanceObserverCallback) {
    ResourceObserver.latest = this
  }

  emit(entries: PerformanceEntry[]) {
    this.callback(
      { getEntries: () => entries } as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver
    )
  }

  takeRecords() {
    return this.records.splice(0)
  }
}

function timing(name = 'http://localhost/wework/executor/v1/rpc', initiatorType = 'fetch') {
  return {
    name,
    entryType: 'resource',
    initiatorType,
    startTime: 100,
    duration: 41_662,
    fetchStart: 100,
    connectStart: 40_100,
    connectEnd: 40_200,
    requestStart: 40_900,
    responseStart: 41_760,
    responseEnd: 41_762,
    nextHopProtocol: 'http/1.1',
  } as PerformanceResourceTiming
}

afterEach(() => {
  ResourceObserver.latest?.disconnect()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('retains new network entries after the browser resource buffer fills with static assets', () => {
  vi.stubGlobal('PerformanceObserver', ResourceObserver)
  const capture = createNetworkTimingCapture('http://localhost/', 'http://control.test/')
  try {
    const observer = ResourceObserver.latest
    observer.emit(Array.from({ length: 250 }, () => timing('http://localhost/static.js', 'script')))
    observer.emit([timing()])

    expect(observer.observe).toHaveBeenCalledExactlyOnceWith({ type: 'resource', buffered: true })
    expect(capture.snapshot().entries).toHaveLength(1)
    expect(capture.snapshot().entries[0]).toMatchObject({
      path: '/wework/executor/v1/rpc',
      fetchStart: 100,
      requestStart: 40_900,
      responseStart: 41_760,
      duration: 41_662,
    })
  } finally {
    capture.stop()
  }
})

test('exports only safe paths and timing fields while retaining unavailable cross-origin zeros', () => {
  vi.stubGlobal('PerformanceObserver', ResourceObserver)
  const capture = createNetworkTimingCapture('http://localhost/', 'http://control.test/')
  try {
    ResourceObserver.latest.emit([
      {
        ...timing('https://user:secret@example.test/api/devices?token=secret#secret'),
        requestStart: 0,
        responseStart: 0,
        nextHopProtocol: '',
        headers: { authorization: 'secret' },
        body: 'secret',
      } as PerformanceResourceTiming,
      timing('http://control.test/commands?token=secret'),
      timing('data:text/plain,secret'),
      timing('http://localhost/static.js', 'script'),
      timing('http://localhost/wework/executor/v1/events?token=secret', 'other'),
    ])
    const snapshot = capture.snapshot()

    expect(snapshot.entries.map(entry => entry.path)).toEqual([
      '/api/devices',
      '/wework/executor/v1/events',
    ])
    expect(snapshot.entries[0]).toMatchObject({
      requestStart: 0,
      responseStart: 0,
      nextHopProtocol: '',
    })
    expect(snapshot.timeOrigin).toBe(performance.timeOrigin)
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|authorization|headers|body|user/)
  } finally {
    capture.stop()
  }
})

test('bounds completed timings, drains pending observer records and returns isolated snapshots', () => {
  vi.stubGlobal('PerformanceObserver', ResourceObserver)
  const capture = createNetworkTimingCapture('http://localhost/', 'http://control.test/')
  try {
    ResourceObserver.latest.emit(
      Array.from({ length: 205 }, (_, index) => timing(`http://localhost/api/${index}`))
    )
    ResourceObserver.latest.records.push(timing('http://localhost/api/latest'))
    const snapshot = capture.snapshot()

    expect(snapshot.entries).toHaveLength(200)
    expect(snapshot.entries[0].path).toBe('/api/6')
    expect(snapshot.entries.at(-1)?.path).toBe('/api/latest')
    snapshot.entries[0].path = '/mutated'
    expect(capture.snapshot().entries[0].path).toBe('/api/6')
  } finally {
    capture.stop()
  }
  expect(ResourceObserver.latest.disconnect).toHaveBeenCalledOnce()
})

test('reports missing observer support without substituting incomplete browser-buffer data', () => {
  vi.stubGlobal('PerformanceObserver', undefined)
  const capture = createNetworkTimingCapture('http://localhost/', 'http://control.test/')
  expect(capture.snapshot()).toMatchObject({
    observerStatus: 'unavailable',
    entries: [],
    limit: 200,
  })
  capture.stop()
})

test('releases the observer when desktop control registration fails', async () => {
  vi.stubGlobal('PerformanceObserver', ResourceObserver)
  vi.stubGlobal('fetch', (url: string) =>
    url.includes('/commands?')
      ? new Promise<Response>(() => {})
      : Promise.resolve(new Response('{}', { status: 500 }))
  )

  await expect(runDesktopControlClient('http://control.test', 'main')).rejects.toThrow(
    'Desktop E2E control registration failed with 500'
  )

  expect(ResourceObserver.latest.disconnect).toHaveBeenCalledOnce()
})

test('the real desktop debug command reads the bounded observer and releases it when the client exits', async () => {
  vi.stubGlobal('PerformanceObserver', ResourceObserver)
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
    Array.from({ length: 250 }, () => timing('http://localhost/static.js', 'script'))
  )
  vi.spyOn(desktopHost, 'invokeDesktopHost').mockResolvedValue(true)
  const results: Array<{ id: string; ok: boolean; value: string }> = []
  let polls = 0
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => {
    if (url.includes('/commands?')) {
      polls += 1
      if (polls === 1) ResourceObserver.latest.emit([timing()])
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: String(polls),
            action: polls === 1 ? 'getWorkbenchDebugSnapshot' : 'refreshFromApplicationMenu',
            selector: 'body',
          })
        )
      )
    }
    if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
    return Promise.resolve(new Response('{}'))
  })

  await runDesktopControlClient('http://control.test', 'main')

  expect(polls).toBe(2)
  expect(results[0].ok).toBe(true)
  const snapshot = JSON.parse(results[0].value)
  expect(snapshot.network).toHaveLength(1)
  expect(snapshot.network[0]).toMatchObject({
    path: '/wework/executor/v1/rpc',
    requestStart: 40_900,
  })
  expect(snapshot.networkTimingCapture).toMatchObject({ observerStatus: 'observing', limit: 200 })
  expect(ResourceObserver.latest.disconnect).toHaveBeenCalledOnce()
})
