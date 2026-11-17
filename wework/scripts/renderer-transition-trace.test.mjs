// @vitest-environment node
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  collectScopedLongAnimationFrames,
  ELEMENT_METRICS_MARKS,
  startRendererTransitionTrace,
} from '../e2e/desktop/modules/renderer-transition-trace.mjs'
import {
  ELEMENT_METRICS_START_MARK,
  ELEMENT_METRICS_STOP_MARK,
} from '../src/e2e/element-frame-metrics.ts'

const devtools = vi.hoisted(() => ({ client: vi.fn(), create: vi.fn(), write: vi.fn() }))
vi.mock('./ai-verify-devtools.mjs', async importOriginal => ({
  ...(await importOriginal()),
  createDevtoolsClient: devtools.create,
  writeDiagnosticFile: devtools.write,
}))

const directory = join(tmpdir(), 'transition-evidence')
const privateValue = 'private-page-text-and-network-token'
const trace = {
  metadata: privateValue,
  traceEvents: [
    {
      name: 'RunTask',
      cat: 'toplevel',
      ph: 'X',
      pid: 3,
      tid: 7,
      ts: 123,
      dur: 395000,
      args: { url: privateValue, text: privateValue },
    },
  ],
}

beforeEach(() => {
  devtools.client.mockReset()
  devtools.create.mockReset().mockResolvedValue(devtools.client)
  devtools.write.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  devtools.client.mockImplementation(async ({ action, method, after }) => {
    if (action === 'targets')
      return [
        { id: 1, type: 'window', url: 'file:///startup-splash.html' },
        { id: 2, type: 'window', url: 'file:///app/index.html' },
      ]
    if (action === 'events')
      return after === 0
        ? { events: [], next: 1, latest: 1, lost: 0, attached: true }
        : {
            events: [
              {
                method: 'Tracing.tracingComplete',
                params: { stream: 'trace', dataLossOccurred: false },
              },
            ],
            next: 2,
            latest: 2,
            lost: 0,
            attached: true,
          }
    if (method === 'IO.read') return { data: JSON.stringify(trace), eof: true }
    return {}
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('captures bounded native timing without enabling network, CPU profiling or retaining arguments', async () => {
  const stop = await startRendererTransitionTrace(directory, 'close.trace.json', 10000)
  expect(devtools.client).toHaveBeenCalledWith({
    action: 'command',
    target: 2,
    method: 'Tracing.start',
    params: {
      transferMode: 'ReturnAsStream',
      traceConfig: {
        recordMode: 'recordUntilFull',
        traceBufferSizeInKb: 4096,
        enableArgumentFilter: true,
        includedCategories: [
          'toplevel',
          'renderer.scheduler',
          'blink',
          'cc',
          'viz',
          'gpu',
          'v8',
          'disabled-by-default-v8.gc',
          'blink.user_timing',
        ],
      },
    },
  })
  await stop()
  await stop()
  const methods = devtools.client.mock.calls.map(([input]) => input.method).filter(Boolean)
  expect(methods).toEqual(['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close'])
  expect(devtools.write).toHaveBeenCalledExactlyOnceWith(
    join(directory, 'close.trace.json'),
    expect.objectContaining({
      lostEvents: 0,
      dataLossOccurred: false,
      traceEvents: [
        { name: 'RunTask', cat: 'toplevel', ph: 'X', pid: 3, tid: 7, ts: 123, dur: 395000 },
      ],
    })
  )
  expect(JSON.stringify(devtools.write.mock.calls)).not.toContain(privateValue)
  expect(devtools.client).toHaveBeenLastCalledWith({ action: 'detach', target: 2 })
})

test('retains only the renderer sampler clock marks from user timing without retaining private names', async () => {
  const markers = [ELEMENT_METRICS_START_MARK, ELEMENT_METRICS_STOP_MARK].map((name, index) => ({
    name,
    cat: 'blink.user_timing',
    ph: 'R',
    pid: 3,
    tid: 7,
    ts: 100000 + index * 395000,
    args: { detail: privateValue },
  }))
  expect(ELEMENT_METRICS_MARKS).toEqual({
    start: ELEMENT_METRICS_START_MARK,
    stop: ELEMENT_METRICS_STOP_MARK,
  })
  const original = devtools.client.getMockImplementation()
  devtools.client.mockImplementation(input =>
    input.method === 'IO.read'
      ? {
          data: JSON.stringify({
            traceEvents: [
              ...trace.traceEvents,
              ...markers,
              { name: privateValue, cat: 'blink.user_timing', ph: 'R', ts: 1 },
            ],
          }),
          eof: true,
        }
      : original(input)
  )
  const stop = await startRendererTransitionTrace(directory, 'close.trace.json', 10000)
  await stop()

  const evidence = devtools.write.mock.calls[0][1]
  expect(evidence.traceEvents.map(event => event.name)).toEqual([
    'RunTask',
    ELEMENT_METRICS_START_MARK,
    ELEMENT_METRICS_STOP_MARK,
  ])
  expect(evidence.traceEvents.slice(1)).toEqual(markers.map(({ args, ...timing }) => timing))
  expect(JSON.stringify(evidence)).not.toContain(privateValue)
})

test('serialized LoAF collection keeps only frames overlapping the marked sampling window', async () => {
  const frame = (startTime, duration) => ({
    startTime,
    duration,
    blockingDuration: duration - 50,
    renderStart: startTime + 30,
    styleAndLayoutStart: startTime + 40,
    firstUIEventTimestamp: startTime + 2,
    scripts: [
      {
        duration: 12,
        sourceURL: 'https://renderer.invalid/app.js?token=secret#private',
        sourceFunctionName: 'sample',
      },
    ],
  })
  const disconnect = vi.fn()
  const observe = vi.fn()
  class Observer {
    static supportedEntryTypes = ['long-animation-frame']
    constructor(callback) {
      this.callback = callback
    }
    observe(options) {
      observe(options)
      this.callback({ getEntries: () => [frame(0, 90), frame(50, 50), frame(90, 60)] })
    }
    takeRecords() {
      return [frame(120, 60), frame(190, 60), frame(200, 60)]
    }
    disconnect() {
      disconnect()
    }
  }
  const result = await runInNewContext(
    `(${collectScopedLongAnimationFrames.toString()})(${JSON.stringify(ELEMENT_METRICS_MARKS)})`,
    {
      PerformanceObserver: Observer,
      performance: {
        timeOrigin: 10000,
        now: () => 1000,
        getEntriesByName: name => [{ startTime: name === ELEMENT_METRICS_START_MARK ? 100 : 200 }],
      },
      setTimeout,
      URL,
    }
  )

  expect(result).toMatchObject({
    supported: true,
    timeOrigin: 10000,
    startTime: 100,
    endTime: 200,
    startMarked: true,
    stopMarked: true,
  })
  expect(result.frames.map(entry => entry.startTime)).toEqual([90, 120, 190])
  expect(result.frames[0].firstUIEventTimestamp).toBe(92)
  expect(result.frames[0].scripts[0].sourceURL).toBe('https://renderer.invalid/app.js')
  expect(observe).toHaveBeenCalledExactlyOnceWith({ type: 'long-animation-frame', buffered: true })
  expect(disconnect).toHaveBeenCalledOnce()
})

test('does not report unscoped historical LoAF entries when the sampler mark is unavailable', async () => {
  const observer = vi.fn()
  const result = await runInNewContext(
    `(${collectScopedLongAnimationFrames.toString()})(${JSON.stringify(ELEMENT_METRICS_MARKS)})`,
    {
      PerformanceObserver: Object.assign(observer, {
        supportedEntryTypes: ['long-animation-frame'],
      }),
      performance: { timeOrigin: 10000, now: () => 1000, getEntriesByName: () => [] },
    }
  )

  expect(result).toMatchObject({
    supported: true,
    startMarked: false,
    stopMarked: false,
    frames: [],
  })
  expect(observer).not.toHaveBeenCalled()
})

test('ends recording at the bound even when the motion action has not returned', async () => {
  vi.useFakeTimers()
  const stop = await startRendererTransitionTrace(directory, 'close.trace.json', 30000)
  await vi.advanceTimersByTimeAsync(9999)
  expect(devtools.client.mock.calls.some(([input]) => input.method === 'Tracing.end')).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(
    devtools.client.mock.calls.filter(([input]) => input.method === 'Tracing.end')
  ).toHaveLength(1)
  await stop()
  expect(
    devtools.client.mock.calls.filter(([input]) => input.method === 'Tracing.end')
  ).toHaveLength(1)
})

test.each(['start', 'end', 'read', 'parse', 'write'])(
  'diagnostic %s failures do not replace the existing motion result and release the debugger',
  async stage => {
    const original = devtools.client.getMockImplementation()
    devtools.client.mockImplementation(async input => {
      if (
        (stage === 'start' && input.method === 'Tracing.start') ||
        (stage === 'end' && input.method === 'Tracing.end') ||
        (stage === 'read' && input.method === 'IO.read')
      )
        throw new Error(privateValue)
      if (stage === 'parse' && input.method === 'IO.read') return { data: 'invalid', eof: true }
      return original(input)
    })
    if (stage === 'write') devtools.write.mockRejectedValue(new Error(privateValue))
    const stop = await startRendererTransitionTrace(directory, 'close.trace.json', 10000)
    await expect(stop()).resolves.toBeUndefined()
    expect(devtools.client).toHaveBeenLastCalledWith({ action: 'detach', target: 2 })
    if (['read', 'parse', 'write'].includes(stage))
      expect(devtools.client).toHaveBeenCalledWith({
        action: 'command',
        target: 2,
        method: 'IO.close',
        params: { handle: 'trace' },
      })
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(privateValue)
  }
)
