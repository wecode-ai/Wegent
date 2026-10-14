import { afterEach, expect, test, vi } from 'vitest'
import { logStartupStep } from './startup-step.js'
import { startupSystemResources } from './startup-system-resources.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function resources() {
  return {
    cpuTimes: [
      { user: 100, nice: 10, sys: 50, idle: 800, irq: 40 },
      { user: 200, nice: 0, sys: 90, idle: 700, irq: 10 },
    ],
    freeMemoryBytes: 4096,
    loadAverage1m: 1.25,
    privateCommand: 'private-command',
    privateModel: 'private-cpu-model',
  }
}

test('reports only fixed system counters without process names or command details', () => {
  expect(startupSystemResources('runtime-configure', 'completed', true, resources)).toEqual({
    systemResourcesAvailable: true,
    systemCpuCount: 2,
    systemCpuTotalMs: 2000,
    systemCpuIdleMs: 1500,
    systemFreeMemoryBytes: 4096,
    systemLoadAverage1m: 1.25,
  })
})

test.each([
  ['runtime-configure', 'completed', false],
  ['runtime-configure', 'started', true],
  ['runtime-configure', 'failed', true],
  ['host-preferences-get', 'completed', true],
  ['private-step', 'completed', true],
])(
  'does not query system APIs outside selected profile boundaries (%s/%s/%s)',
  (step, status, enabled) => {
    const read = vi.fn(resources)
    expect(startupSystemResources(step, status, enabled, read)).toEqual({})
    expect(read).not.toHaveBeenCalled()
  }
)

test.each([undefined, NaN, Infinity, -1])(
  'omits an unavailable load average (%s)',
  loadAverage1m => {
    const result = startupSystemResources('primary-renderer-load', 'started', true, () => ({
      ...resources(),
      loadAverage1m,
    }))
    expect(result.systemResourcesAvailable).toBe(true)
    expect(result).not.toHaveProperty('systemLoadAverage1m')
  }
)

test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid CPU counters without exposing their values (%s)',
  user => {
    expect(
      startupSystemResources('renderer-startup-ready', 'completed', true, () => ({
        ...resources(),
        cpuTimes: [{ ...resources().cpuTimes[0]!, user }],
      }))
    ).toEqual({ systemResourcesAvailable: false })
  }
)

test('rejects missing CPU data and overflowing totals', () => {
  for (const cpuTimes of [
    [],
    [{ user: Number.MAX_SAFE_INTEGER, nice: 0, sys: 1, idle: 1, irq: 0 }],
  ]) {
    expect(
      startupSystemResources('runtime-configure', 'completed', true, () => ({
        ...resources(),
        cpuTimes,
      }))
    ).toEqual({ systemResourcesAvailable: false })
  }
})

test('does not expose invalid memory counters or sampling exceptions', () => {
  for (const read of [
    () => ({ ...resources(), freeMemoryBytes: -1 }),
    () => {
      throw new Error('private-sampling-error')
    },
  ]) {
    expect(startupSystemResources('runtime-configure', 'completed', true, read)).toEqual({
      systemResourcesAvailable: false,
    })
  }
})

test('wires native system counters only to a selected completed startup boundary', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.stubEnv('WEWORK_E2E_CORE_CPU_PROFILE', '1')
  logStartupStep('runtime-configure', 'started')
  expect(log.mock.calls[0]![1]).not.toHaveProperty('systemResourcesAvailable')
  logStartupStep('runtime-configure', 'completed')
  expect(log.mock.calls[1]![1]).toMatchObject({
    step: 'runtime-configure',
    status: 'completed',
    systemResourcesAvailable: true,
    systemCpuCount: expect.any(Number),
    systemCpuTotalMs: expect.any(Number),
    systemCpuIdleMs: expect.any(Number),
    systemFreeMemoryBytes: expect.any(Number),
  })
  vi.stubEnv('WEWORK_E2E_CORE_CPU_PROFILE', '0')
  logStartupStep('runtime-configure', 'completed')
  expect(log.mock.calls[2]![1]).not.toHaveProperty('systemResourcesAvailable')
})
