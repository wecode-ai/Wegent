// @vitest-environment node
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startRendererTransitionTrace } from '../e2e/desktop/modules/renderer-transition-trace.mjs'

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
