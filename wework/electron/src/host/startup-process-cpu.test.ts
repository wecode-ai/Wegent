import type { ProcessMetric } from 'electron'
import { expect, test, vi } from 'vitest'
import { startupProcessCpuDetails } from './startup-process-cpu.js'

const contents = () => ({ isDestroyed: () => false, getOSProcessId: () => 23 })

function metric(pid: number, type: ProcessMetric['type'], seconds = 0.1): ProcessMetric {
  return {
    pid,
    type,
    cpu: { cumulativeCPUUsage: seconds },
    name: 'private-process-name',
    serviceName: 'private-service-url',
  } as ProcessMetric
}

test('reuses one metrics snapshot and exposes only numeric identities and fixed process kinds', () => {
  const getMetrics = vi.fn(() => [
    metric(24, 'GPU', 0.23456),
    metric(23, 'Tab', 1.23456),
    metric(22, 'Browser'),
    metric(25, 'Utility'),
    metric(26, 'Zygote'),
  ])
  const result = startupProcessCpuDetails(true, contents(), getMetrics)

  expect(getMetrics).toHaveBeenCalledOnce()
  expect(result).toEqual({
    rendererCpuAvailable: true,
    rendererCpuProcessId: 23,
    rendererCpuMs: 1235,
    electronCpuAvailable: true,
    electronCpuTotalMs: 1770,
    electronCpuProcessCount: 5,
    electronCpuSamples: [
      { pid: 22, kind: 'browser', cpuMs: 100 },
      { pid: 23, kind: 'renderer', cpuMs: 1235 },
      { pid: 24, kind: 'gpu', cpuMs: 235 },
      { pid: 25, kind: 'utility', cpuMs: 100 },
      { pid: 26, kind: 'other', cpuMs: 100 },
    ],
  })
  expect(JSON.stringify(result)).not.toMatch(/private|service|Zygote/)
})

test.each([false, true])(
  'does not add a metrics query without an eligible renderer (%s)',
  enabled => {
    const getMetrics = vi.fn()
    expect(startupProcessCpuDetails(enabled, null, getMetrics)).toEqual(
      enabled ? { rendererCpuAvailable: false } : {}
    )
    expect(getMetrics).not.toHaveBeenCalled()
  }
)

test('disabled diagnostics never touch renderer or metrics APIs', () => {
  const renderer = { isDestroyed: vi.fn(), getOSProcessId: vi.fn() }
  const getMetrics = vi.fn()
  expect(startupProcessCpuDetails(false, renderer, getMetrics)).toEqual({})
  expect(renderer.isDestroyed).not.toHaveBeenCalled()
  expect(getMetrics).not.toHaveBeenCalled()
})

test('preserves missing-renderer evidence and reports the actual observed processes', () => {
  const result = startupProcessCpuDetails(true, contents(), () => [metric(24, 'GPU', 0)])
  expect(result).toEqual({
    rendererCpuAvailable: false,
    electronCpuAvailable: true,
    electronCpuTotalMs: 0,
    electronCpuProcessCount: 1,
    electronCpuSamples: [{ pid: 24, kind: 'gpu', cpuMs: 0 }],
  })
})

test.each([NaN, Infinity, -Infinity, -0.001, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER])(
  'does not emit partial totals for an invalid process CPU (%s)',
  seconds => {
    const result = startupProcessCpuDetails(true, contents(), () => [
      metric(23, 'Tab'),
      metric(24, 'GPU', seconds),
    ])
    expect(result).toEqual({
      rendererCpuAvailable: true,
      rendererCpuProcessId: 23,
      rendererCpuMs: 100,
      electronCpuAvailable: false,
    })
  }
)

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 23])(
  'rejects invalid or duplicate numeric process identities (%s)',
  pid => {
    const result = startupProcessCpuDetails(true, contents(), () => [
      metric(23, 'Tab'),
      metric(pid, 'GPU'),
    ])
    expect(result.electronCpuAvailable).toBe(false)
    expect(result).not.toHaveProperty('electronCpuTotalMs')
    expect(result).not.toHaveProperty('electronCpuSamples')
  }
)

test('rejects a cumulative sum outside the safe integer range', () => {
  const seconds = Number.MAX_SAFE_INTEGER / 1000
  const result = startupProcessCpuDetails(true, contents(), () => [
    metric(23, 'Tab', seconds),
    metric(24, 'GPU', seconds),
  ])
  expect(result.electronCpuAvailable).toBe(false)
  expect(result).not.toHaveProperty('electronCpuTotalMs')
})

test('rejects a process without cumulative CPU time instead of reporting a partial total', () => {
  const missing = metric(24, 'GPU')
  delete missing.cpu.cumulativeCPUUsage
  const result = startupProcessCpuDetails(true, contents(), () => [metric(23, 'Tab'), missing])
  expect(result.electronCpuAvailable).toBe(false)
  expect(result).not.toHaveProperty('electronCpuTotalMs')
})

test('keeps metric exceptions private and outside the startup control flow', () => {
  const result = startupProcessCpuDetails(true, contents(), () => {
    throw new Error('private-token')
  })
  expect(result).toEqual({ rendererCpuAvailable: false })

  const broken = metric(24, 'GPU')
  Object.defineProperty(broken, 'type', {
    get() {
      throw new Error('private-token')
    },
  })
  expect(startupProcessCpuDetails(true, contents(), () => [metric(23, 'Tab'), broken])).toEqual({
    rendererCpuAvailable: true,
    rendererCpuProcessId: 23,
    rendererCpuMs: 100,
    electronCpuAvailable: false,
  })
})

test('keeps each snapshot independent when a process exits or is replaced', () => {
  const before = startupProcessCpuDetails(true, contents(), () => [
    metric(23, 'Tab', 1),
    metric(24, 'GPU', 2),
  ])
  const after = startupProcessCpuDetails(true, contents(), () => [
    metric(23, 'Tab', 1.2),
    metric(25, 'GPU', 0.1),
  ])
  expect(before.electronCpuSamples).toEqual([
    { pid: 23, kind: 'renderer', cpuMs: 1000 },
    { pid: 24, kind: 'gpu', cpuMs: 2000 },
  ])
  expect(after.electronCpuSamples).toEqual([
    { pid: 23, kind: 'renderer', cpuMs: 1200 },
    { pid: 25, kind: 'gpu', cpuMs: 100 },
  ])
})
