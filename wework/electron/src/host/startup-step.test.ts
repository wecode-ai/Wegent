import { afterEach, expect, test, vi } from 'vitest'
import { rendererStartupCpuDetails, runSynchronousStartupStep } from './startup-step.js'

afterEach(() => vi.restoreAllMocks())

function rendererContents(pid = 23) {
  return { isDestroyed: vi.fn(() => false), getOSProcessId: vi.fn(() => pid) }
}

function cpuMetric(pid: number, cumulativeCPUUsage?: number) {
  return {
    pid,
    cpu: { cumulativeCPUUsage, percentCPUUsage: 99, idleWakeupsPerSecond: 77 },
    name: 'private-process-name',
    serviceName: 'private-service',
  }
}

test('samples only the exact renderer PID and exposes rounded cumulative CPU milliseconds', () => {
  const contents = rendererContents()
  const metrics = vi.fn(() => [cpuMetric(24, 999), cpuMetric(23, 1.23456)])
  const result = rendererStartupCpuDetails(true, contents, metrics)
  expect(result).toEqual({
    rendererCpuAvailable: true,
    rendererCpuProcessId: 23,
    rendererCpuMs: 1235,
  })
  expect(contents.getOSProcessId).toHaveBeenCalledOnce()
  expect(metrics).toHaveBeenCalledOnce()
  expect(JSON.stringify(result)).not.toMatch(/private|percentCPU|idleWake/)
})

test('does not query renderer or app metrics when the profile switch is disabled', () => {
  const contents = rendererContents()
  const metrics = vi.fn()
  expect(rendererStartupCpuDetails(false, contents, metrics)).toEqual({})
  expect(contents.isDestroyed).not.toHaveBeenCalled()
  expect(contents.getOSProcessId).not.toHaveBeenCalled()
  expect(metrics).not.toHaveBeenCalled()
})

test.each([undefined, NaN, Infinity, -Infinity, -0.01, Number.MAX_VALUE])(
  'reports unavailable for an invalid cumulative CPU value (%s)',
  seconds => {
    expect(
      rendererStartupCpuDetails(true, rendererContents(), () => [cpuMetric(23, seconds)])
    ).toEqual({ rendererCpuAvailable: false })
  }
)

test('accepts a renderer with zero cumulative CPU time', () => {
  expect(rendererStartupCpuDetails(true, rendererContents(), () => [cpuMetric(23, 0)])).toEqual({
    rendererCpuAvailable: true,
    rendererCpuProcessId: 23,
    rendererCpuMs: 0,
  })
})

test('does not use another process when the renderer PID is absent', () => {
  expect(rendererStartupCpuDetails(true, rendererContents(), () => [cpuMetric(24, 5)])).toEqual({
    rendererCpuAvailable: false,
  })
})

test.each([null, { ...rendererContents(), isDestroyed: () => true }, rendererContents(0)])(
  'reports an unavailable renderer without querying app metrics (%#)',
  contents => {
    const metrics = vi.fn()
    expect(rendererStartupCpuDetails(true, contents, metrics)).toEqual({
      rendererCpuAvailable: false,
    })
    expect(metrics).not.toHaveBeenCalled()
  }
)

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects an invalid renderer PID before querying app metrics (%s)',
  pid => {
    const metrics = vi.fn()
    expect(rendererStartupCpuDetails(true, rendererContents(pid), metrics)).toEqual({
      rendererCpuAvailable: false,
    })
    expect(metrics).not.toHaveBeenCalled()
  }
)

test('keeps diagnostic API failures private and does not throw into startup', () => {
  const failure = new Error('private-path-token')
  const metrics = () => {
    throw failure
  }
  expect(rendererStartupCpuDetails(true, rendererContents(), metrics)).toEqual({
    rendererCpuAvailable: false,
  })
  const contents = rendererContents()
  contents.getOSProcessId.mockImplementation(() => {
    throw failure
  })
  expect(rendererStartupCpuDetails(true, contents, metrics)).toEqual({
    rendererCpuAvailable: false,
  })
})

test('preserves the synchronous result and execution count', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const result = Symbol('result')
  const operation = vi.fn(() => result)

  expect(runSynchronousStartupStep('development-app-data-read', operation)).toBe(result)
  expect(operation).toHaveBeenCalledOnce()
  expect(info.mock.calls.map(([, event]) => event.status)).toEqual(['started', 'completed'])
})

test.each([
  new SyntaxError('private-path'),
  new TypeError('private-token'),
  new Error('private-url'),
])('reports a fixed kind and propagates the original failure (%#)', failure => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  let caught: unknown
  try {
    runSynchronousStartupStep('development-app-data-read', () => {
      throw failure
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(failure)
  expect(info.mock.calls.map(([, event]) => event.status)).toEqual(['started', 'failed'])
  expect(info.mock.calls.at(-1)?.[1].errorKind).toBe(failure.constructor.name)
  expect(JSON.stringify(info.mock.calls)).not.toContain('private')
})
