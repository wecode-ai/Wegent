import { describe, expect, it, vi } from 'vitest'
import type { ElectronProcessMetric } from '../core/build-snapshot.js'
import { ProcessExplorerService } from './service.js'
import type { SystemProcessTableResult } from './system-process-table.js'

const executorProcess = {
  pid: 40,
  name: 'Executor',
  kind: 'host-service' as const,
  owner: { id: 'executor', label: 'Executor' },
}

function deferredSystemTable() {
  let resolve!: (value: SystemProcessTableResult) => void
  const pending = new Promise<SystemProcessTableResult>(complete => {
    resolve = complete
  })
  return {
    read: vi.fn(() => pending),
    complete: () =>
      resolve({
        processes: [
          {
            pid: 40,
            parentPid: 10,
            name: 'Executor',
            command: 'executor',
            cpuPercent: 1,
            memoryBytes: 4096,
            startedAt: 1000,
            identity: 'created-40',
          },
        ],
        degraded: [],
      }),
  }
}

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
  it('collects current Electron identities when a fresh snapshot bypasses the cached view', async () => {
    let splashClosed = false
    const metrics = vi.fn(() => [
      metric(10, 'Browser'),
      metric(30, 'Tab'),
      ...(splashClosed ? [] : [metric(44, 'Tab')]),
    ])
    const { service, advance } = createService({ metrics })
    const cached = await service.snapshot()
    expect(await service.snapshot()).toBe(cached)
    expect(metrics).toHaveBeenCalledOnce()
    splashClosed = true
    advance(10)
    const current = await service.snapshot({ fresh: true })
    expect(current.processes.map(row => row.pid)).toEqual([10, 30])
    expect(metrics).toHaveBeenCalledTimes(2)
  })

  it('bypasses cached metrics when external enumeration rebuilds a fresh snapshot', async () => {
    const table = deferredSystemTable()
    let splashClosed = false
    const metrics = vi.fn(() => [
      metric(10, 'Browser'),
      metric(30, 'Tab'),
      ...(splashClosed ? [] : [metric(44, 'Tab')]),
    ])
    const { service, advance } = createService({ metrics, systemTable: table })
    await service.snapshot({ waitForSystemProcesses: false })
    splashClosed = true
    advance(10)
    table.complete()
    const current = await service.snapshot({ fresh: true })
    expect(current.processes.filter(row => row.source === 'electron').map(row => row.pid)).toEqual([
      10, 30,
    ])
    expect(metrics).toHaveBeenCalledTimes(2)
  })

  it('discards an external process-table read started before a fresh request', async () => {
    const priorTable = deferredSystemTable()
    const nextTable = {
      processes: [
        {
          pid: 41,
          parentPid: 10,
          name: 'Current child',
          command: null,
          cpuPercent: 0,
          memoryBytes: 1024,
          startedAt: 2000,
          identity: 'current-41',
        },
      ],
      degraded: [],
    }
    const read = vi.fn().mockImplementationOnce(priorTable.read).mockResolvedValue(nextTable)
    const { service } = createService({ systemTable: { read } })
    const prior = service.snapshot()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    const fresh = service.snapshot({ fresh: true })
    priorTable.complete()
    await prior
    const current = await fresh
    expect(read).toHaveBeenCalledTimes(2)
    expect(current.processes.filter(row => row.source === 'system').map(row => row.pid)).toEqual([
      41,
    ])
  })

  it('bounds fresh waits without accumulating external collectors behind a hung read', async () => {
    vi.useFakeTimers()
    try {
      let release!: (result: SystemProcessTableResult) => void
      const read = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              release = resolve
            })
        )
        .mockResolvedValue({ processes: [], degraded: [] })
      const { service } = createService({ systemTable: { read }, systemTableTimeoutMs: 50 })
      const prior = service.snapshot()
      await vi.advanceTimersByTimeAsync(0)
      for (let request = 0; request < 2; request++) {
        const fresh = service.snapshot({ fresh: true })
        await vi.advanceTimersByTimeAsync(50)
        expect((await fresh).degraded[0]?.code).toBe('system-process-table-failed')
        expect(read).toHaveBeenCalledOnce()
      }
      await prior
      release({ processes: [], degraded: [] })
      await vi.advanceTimersByTimeAsync(0)
      expect((await service.snapshot({ fresh: true })).degraded).toEqual([])
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([false, true])(
    'does not reuse an older in-flight collection with fresh=%s',
    async firstFresh => {
      let release!: (descriptors: (typeof executorProcess)[]) => void
      const held = new Promise<(typeof executorProcess)[]>(resolve => {
        release = resolve
      })
      const currentExecutor = { ...executorProcess, pid: 41 }
      const hostProcesses = vi.fn().mockReturnValueOnce(held).mockReturnValue([currentExecutor])
      let splashClosed = false
      const metrics = vi.fn(() => [
        metric(10, 'Browser'),
        metric(30, 'Tab'),
        ...(splashClosed ? [] : [metric(44, 'Tab')]),
      ])
      const { service, advance } = createService({ metrics, hostProcesses })
      const older = service.snapshot({ fresh: firstFresh })
      await vi.waitFor(() => expect(hostProcesses).toHaveBeenCalledOnce())
      splashClosed = true
      advance(10)
      let delivered: Awaited<typeof older> | undefined
      const fresh = service.snapshot({ fresh: true }).then(snapshot => {
        delivered = snapshot
        return snapshot
      })
      try {
        await vi.waitFor(() => expect(delivered).toBeDefined(), { timeout: 100 })
        expect(delivered?.processes.map(row => row.pid)).toEqual([10, 30, 41])
        expect(metrics).toHaveBeenCalledTimes(2)
      } finally {
        release([executorProcess])
        await older
        await fresh
      }
      expect((await service.snapshot({ fresh: true })).processes.map(row => row.pid)).toEqual([
        10, 30, 41,
      ])
    }
  )

  it.each(['preview-first', 'complete-first'])(
    'waits for authoritative host identities with %s requests',
    async order => {
      const table = deferredSystemTable()
      const { service, metrics } = createService({
        systemTable: table,
        hostProcesses: () => [executorProcess],
      })
      let delivered = false
      const complete = () =>
        service.snapshot().then(value => {
          delivered = true
          return value
        })
      const full = order === 'complete-first' ? complete() : null
      const preview = await service.snapshot({ waitForSystemProcesses: false })
      expect(preview.collectingSystemProcesses).toBe(true)
      expect(preview.processes.find(row => row.pid === 40)?.startedAt).toBeNull()
      const pending = full ?? complete()
      await service.snapshot({ waitForSystemProcesses: false })
      expect(delivered).toBe(false)
      table.complete()
      const snapshot = await pending
      expect(snapshot.collectingSystemProcesses).toBe(false)
      expect(snapshot.processes.find(row => row.pid === 40)?.startedAt).toBe(1000)
      expect(await service.snapshot()).toBe(snapshot)
      expect(table.read).toHaveBeenCalledTimes(1)
      expect(metrics).toHaveBeenCalledTimes(1)
    }
  )

  it('does not share a pending preview or overwrite a complete cached snapshot', async () => {
    const table = deferredSystemTable()
    let release!: (value: (typeof executorProcess)[]) => void
    const heldHost = new Promise<(typeof executorProcess)[]>(resolve => {
      release = resolve
    })
    const hostProcesses = vi.fn().mockReturnValueOnce(heldHost).mockReturnValue([executorProcess])
    const { service, metrics } = createService({ systemTable: table, hostProcesses })
    const preview = service.snapshot({ waitForSystemProcesses: false })
    const full = service.snapshot()
    let snapshot: Awaited<typeof full> | undefined
    const delivered = full.then(value => {
      snapshot = value
    })
    table.complete()
    try {
      await vi.waitFor(() =>
        expect(snapshot?.processes.find(row => row.pid === 40)?.startedAt).toBe(1000)
      )
    } finally {
      release([executorProcess])
    }
    await delivered
    expect((await preview).processes.find(row => row.pid === 40)?.startedAt).toBeNull()
    expect(await service.snapshot()).toBe(snapshot)
    expect(table.read).toHaveBeenCalledTimes(1)
    expect(metrics).toHaveBeenCalledTimes(1)
  })

  it('shows authoritative Electron metrics while external enumeration is pending', async () => {
    const read = vi.fn(() => new Promise<never>(() => undefined))
    const { service, advance } = createService({ systemTable: { read } })
    const snapshot = await service.snapshot({ waitForSystemProcesses: false })
    expect(snapshot.processes.map(row => row.pid)).toEqual([10, 20, 30])
    expect(snapshot.collectingSystemProcesses).toBe(true)
    advance(2000)
    expect((await service.snapshot({ waitForSystemProcesses: false })).processes).toHaveLength(3)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('supplements metrics with a completed external enumeration', async () => {
    let complete!: (value: SystemProcessTableResult) => void
    const { service } = createService({
      systemTable: {
        read: () =>
          new Promise(resolve => {
            complete = resolve
          }),
      },
    })
    expect(
      (await service.snapshot({ waitForSystemProcesses: false })).collectingSystemProcesses
    ).toBe(true)
    complete({
      processes: [
        {
          pid: 40,
          parentPid: 10,
          name: 'Child',
          command: 'child',
          cpuPercent: 1,
          memoryBytes: 4096,
          startedAt: 1000,
          identity: 'created',
        },
      ],
      degraded: [],
    })
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot({ waitForSystemProcesses: false })
      expect(snapshot.collectingSystemProcesses).toBe(false)
      expect(snapshot.processes.find(row => row.pid === 40)).toMatchObject({
        source: 'system',
        parentPid: 10,
        name: 'Child',
        memoryBytes: 4096,
      })
    })
  })

  it('keeps the shared CPU measurement window when external enumeration completes', async () => {
    let complete!: (value: { processes: []; degraded: [] }) => void
    const { service, metrics, advance } = createService({
      systemTable: {
        read: () =>
          new Promise(resolve => {
            complete = resolve
          }),
      },
    })
    await service.snapshot({ waitForSystemProcesses: false })
    advance(100)
    complete({ processes: [], degraded: [] })
    await vi.waitFor(async () => {
      expect(
        (await service.snapshot({ waitForSystemProcesses: false })).collectingSystemProcesses
      ).toBe(false)
    })
    advance(100)
    await service.snapshot({ waitForSystemProcesses: false })
    expect(metrics).toHaveBeenCalledTimes(1)
    advance(1000)
    await service.snapshot({ waitForSystemProcesses: false })
    expect(metrics).toHaveBeenCalledTimes(2)
  })
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
    await vi.waitFor(async () => {
      expect((await service.snapshot()).degraded).toEqual([
        { code: 'system-process-table-unavailable', detail: 'unsupported' },
      ])
    })
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
      await pending
      const snapshot = await service.snapshot()
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
      await second
      const snapshot = await service.snapshot()

      expect(read).toHaveBeenCalledTimes(1)
      expect(snapshot.degraded).toEqual([
        { code: 'system-process-table-failed', detail: 'System process table read timed out' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds pending waiters and timeout timers across later sampling windows', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    try {
      const read = vi.fn(() => new Promise<never>(() => undefined))
      const { service, metrics, advance } = createService({
        systemTable: { read },
        systemTableTimeoutMs: 50,
      })
      const first = service.snapshot()
      await vi.advanceTimersByTimeAsync(50)
      const degraded = (await first).degraded
      // Count retained waiters on the service-owned promise, not its assimilated source.
      const pending = (
        service as unknown as { pendingSystemTableRead: Promise<SystemProcessTableResult> }
      ).pendingSystemTableRead
      const waiters = vi.spyOn(pending, 'then')
      timeout.mockClear()

      for (let sample = 0; sample < 5; sample += 1) {
        advance(2_000)
        let delivered = false
        const next = service.snapshot().then(snapshot => {
          delivered = true
          return snapshot
        })
        await vi.advanceTimersByTimeAsync(0)
        expect.soft(delivered).toBe(true)
        if (!delivered) await vi.advanceTimersByTimeAsync(50)
        expect((await next).degraded).toEqual(degraded)
      }

      expect.soft(waiters).not.toHaveBeenCalled()
      expect.soft(timeout).not.toHaveBeenCalled()
      expect(read).toHaveBeenCalledOnce()
      expect(metrics).toHaveBeenCalledTimes(6)
    } finally {
      timeout.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each(['resolve', 'reject'] as const)(
    'recovers after a timed-out underlying read eventually %ss',
    async outcome => {
      vi.useFakeTimers()
      try {
        let settle!: () => void
        const read = vi.fn<() => Promise<SystemProcessTableResult>>()
        read.mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              settle = () =>
                outcome === 'resolve'
                  ? resolve({ processes: [], degraded: [] })
                  : reject(new Error('Late system read failure'))
            })
        )
        const recovered = deferredSystemTable()
        recovered.complete()
        read.mockImplementation(() => recovered.read())
        const { service, advance } = createService({
          systemTable: { read },
          systemTableTimeoutMs: 50,
        })
        const first = service.snapshot()
        await vi.advanceTimersByTimeAsync(50)
        expect((await first).degraded).toHaveLength(1)

        settle()
        await vi.advanceTimersByTimeAsync(0)
        advance(2_000)
        const snapshot = await service.snapshot()

        expect(read).toHaveBeenCalledTimes(2)
        expect(snapshot.degraded).toEqual([])
        expect(snapshot.collectingSystemProcesses).toBe(false)
        expect(snapshot.processes.find(row => row.pid === 40)?.startedAt).toBe(1000)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
