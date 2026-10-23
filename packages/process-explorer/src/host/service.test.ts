import { describe, expect, it, vi } from 'vitest'
import type { ElectronProcessMetric } from '../core/build-snapshot.js'
import { ProcessExplorerService } from './service.js'

function metric(pid: number, type: string): ElectronProcessMetric {
  return {
    pid,
    type,
    creationTime: 1000 + pid,
    cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: 1024 },
  }
}

function createService(
  overrides: Partial<ConstructorParameters<typeof ProcessExplorerService>[0]> = {}
) {
  const metrics = vi.fn(
    () => [metric(10, 'Browser'), metric(20, 'GPU'), metric(30, 'Tab')] as ElectronProcessMetric[]
  )
  let now = 1000
  const service = new ProcessExplorerService({
    applicationPid: 10,
    metrics,
    now: () => now,
    ...overrides,
  })
  return {
    service,
    metrics,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
  }
}

describe('ProcessExplorerService', () => {
  it('shares one metrics measurement window across consumers', async () => {
    const { service, metrics, advance } = createService()
    const first = await service.snapshot()
    const second = await service.snapshot()
    expect(second).toBe(first)
    expect(metrics).toHaveBeenCalledTimes(1)

    advance(1000)
    const third = await service.snapshot()
    expect(third).not.toBe(first)
    expect(metrics).toHaveBeenCalledTimes(2)
  })

  it('reports host provider failures as structured degradation', async () => {
    const { service } = createService({
      hostProcesses: () => {
        throw new Error('host provider failed')
      },
    })
    const snapshot = await service.snapshot()
    expect(snapshot.degraded).toEqual([
      { code: 'host-process-provider-failed', detail: 'host provider failed' },
    ])
  })

  it('reports renderer label failures as structured degradation', async () => {
    const { service } = createService({
      windows: () => {
        throw new Error('labels failed')
      },
    })
    const snapshot = await service.snapshot()
    expect(snapshot.degraded).toEqual([{ code: 'renderer-labels-failed', detail: 'labels failed' }])
  })

  it('passes system table degradation through', async () => {
    const { service } = createService({
      systemTable: {
        read: async () => ({
          processes: [],
          degraded: [{ code: 'system-process-table-unavailable' as const, detail: 'unsupported' }],
        }),
      },
    })
    const snapshot = await service.snapshot()
    expect(snapshot.degraded).toEqual([
      { code: 'system-process-table-unavailable', detail: 'unsupported' },
    ])
  })

  it('times out a hung system table read instead of wedging the service', async () => {
    vi.useFakeTimers()
    try {
      const { service } = createService({
        systemTable: { read: () => new Promise<never>(() => undefined) },
        systemTableTimeoutMs: 50,
      })
      const pending = service.snapshot()
      await vi.advanceTimersByTimeAsync(50)
      const snapshot = await pending
      expect(snapshot.degraded).toEqual([
        { code: 'system-process-table-failed', detail: 'System process table read timed out' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses a timed-out system table read instead of starting another', async () => {
    vi.useFakeTimers()
    try {
      const read = vi.fn(() => new Promise<never>(() => undefined))
      const { service, advance } = createService({
        systemTable: { read },
        systemTableTimeoutMs: 50,
      })

      const first = service.snapshot()
      await vi.advanceTimersByTimeAsync(50)
      await first
      advance(2_000)

      const second = service.snapshot()
      await vi.advanceTimersByTimeAsync(50)
      const snapshot = await second

      expect(read).toHaveBeenCalledTimes(1)
      expect(snapshot.degraded).toEqual([
        { code: 'system-process-table-failed', detail: 'System process table read timed out' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
