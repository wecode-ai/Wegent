import { describe, expect, it, vi } from 'vitest'
import type { ProcessDegradation } from '../contract.js'
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

function systemRow(pid: number, parentPid: number, identity: string) {
  return {
    pid,
    parentPid,
    name: `Process ${pid}`,
    command: `process-${pid}`,
    cpuPercent: 1,
    memoryBytes: 4096,
    startedAt: 1000,
    identity,
  }
}

/** A table whose rows the test replaces between samples. */
function mutableTable() {
  let rows = [systemRow(40, 10, 'created-40'), systemRow(41, 40, 'created-41')]
  let degraded: ProcessDegradation[] = []
  const read = vi.fn(async () => ({ processes: rows, degraded }))
  return {
    read,
    setRows(next: ReturnType<typeof systemRow>[]) {
      rows = next
      degraded = []
    },
    fail() {
      degraded = [{ code: 'system-process-table-failed', detail: 'ps failed' }]
    },
  }
}

describe('ProcessExplorerService', () => {
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

  describe('exited processes', () => {
    it('keeps an exited process for the linger window and keeps its orphan in the group', async () => {
      const table = mutableTable()
      let descriptors: (typeof executorProcess)[] = [executorProcess]
      const { service, advance } = createService({
        systemTable: { read: table.read },
        hostProcesses: () => descriptors,
      })
      expect((await service.snapshot()).recentlyExited).toEqual([])

      advance(1000)
      descriptors = []
      table.setRows([systemRow(41, 1, 'created-41')])
      const snapshot = await service.snapshot()

      expect(snapshot.processes.map(row => row.pid)).toEqual([10, 20, 30, 41])
      expect(snapshot.recentlyExited).toHaveLength(1)
      expect(snapshot.recentlyExited[0]).toMatchObject({
        pid: 40,
        name: 'Executor',
        owner: { id: 'executor' },
        cpuPercent: 1,
        memoryBytes: 4096,
        exitedAt: 2000,
      })
      expect(snapshot.processes.find(row => row.pid === 41)).toMatchObject({
        // The OS reported parentPid 1; the snapshot keeps the exited parent
        // so the child renders under it while the parent lingers.
        parentPid: 40,
        kind: 'host-child',
        owner: { id: 'executor' },
      })

      advance(5000)
      expect((await service.snapshot()).recentlyExited).toHaveLength(1)
      advance(1000)
      expect((await service.snapshot()).recentlyExited).toEqual([])
    })

    it('does not report exits after a sampling gap longer than the linger window', async () => {
      const table = mutableTable()
      const { service, advance } = createService({ systemTable: { read: table.read } })
      await service.snapshot()

      advance(6000)
      table.setRows([systemRow(41, 1, 'created-41')])
      expect((await service.snapshot()).recentlyExited).toEqual([])
    })

    it('does not treat a failed system table read as every process exiting', async () => {
      const table = mutableTable()
      const { service, advance } = createService({ systemTable: { read: table.read } })
      await service.snapshot()

      advance(1000)
      table.setRows([])
      table.fail()
      const failed = await service.snapshot()
      expect(failed.processes.map(row => row.pid)).toEqual([10, 20, 30])
      expect(failed.recentlyExited).toEqual([])

      // The next complete table is compared with the last complete one.
      advance(1000)
      table.setRows([systemRow(41, 1, 'created-41')])
      const recovered = await service.snapshot()
      expect(recovered.degraded).toEqual([])
      expect(recovered.recentlyExited.map(row => row.pid)).toEqual([40])
    })

    it('does not infer exits when host process metadata fails', async () => {
      const table = mutableTable()
      let failHost = false
      const { service, advance } = createService({
        systemTable: { read: table.read },
        hostProcesses: () => {
          if (failHost) throw new Error('runtime unavailable')
          return [{ ...executorProcess, identity: 'executor', includeDescendants: true }]
        },
      })
      await service.snapshot()

      advance(1000)
      failHost = true
      const degraded = await service.snapshot()
      expect(degraded.degraded).toContainEqual({
        code: 'host-process-provider-failed',
        detail: 'runtime unavailable',
      })
      expect(degraded.recentlyExited).toEqual([])

      // The baseline survived, so nothing is reported exited once it recovers.
      advance(1000)
      failHost = false
      const recovered = await service.snapshot()
      expect(recovered.recentlyExited).toEqual([])
      expect(recovered.processes.filter(row => row.pid === 40).map(row => row.id)).toEqual([
        '40:executor',
      ])
    })

    it('keeps the whole subtree and ownership of a reparented child', async () => {
      const table = mutableTable()
      table.setRows([systemRow(40, 10, 'c40'), systemRow(41, 40, 'c41'), systemRow(42, 41, 'c42')])
      let descriptors: (typeof executorProcess)[] = [
        { ...executorProcess, identity: 'executor', includeDescendants: true },
      ]
      const { service, advance } = createService({
        systemTable: { read: table.read },
        hostProcesses: () => descriptors,
      })
      await service.snapshot()

      advance(1000)
      descriptors = []
      table.setRows([systemRow(41, 1, 'c41'), systemRow(42, 41, 'c42')])
      const snapshot = await service.snapshot()
      expect(snapshot.recentlyExited.map(row => row.pid)).toEqual([40])
      expect(snapshot.processes.filter(row => row.pid >= 41)).toMatchObject([
        { pid: 41, parentPid: 40, kind: 'host-child', owner: { id: 'executor' } },
        { pid: 42, parentPid: 41, kind: 'host-child', owner: { id: 'executor' } },
      ])
    })

    it('uses the restored snapshot as the exit baseline', async () => {
      const table = mutableTable()
      let descriptors: (typeof executorProcess)[] = [
        { ...executorProcess, identity: 'executor', includeDescendants: true },
      ]
      const { service, advance } = createService({
        systemTable: { read: table.read },
        hostProcesses: () => descriptors,
      })
      await service.snapshot()

      advance(1000)
      descriptors = []
      table.setRows([systemRow(41, 1, 'created-41')])
      await service.snapshot()

      advance(1000)
      table.setRows([])
      const snapshot = await service.snapshot()
      expect(snapshot.recentlyExited.map(row => row.pid)).toEqual([40, 41])
    })

    it('does not renew the baseline from a stale table reused by a preview', async () => {
      let resolveRead!: (value: {
        processes: ReturnType<typeof systemRow>[]
        degraded: ProcessDegradation[]
      }) => void
      const read = vi.fn(
        () =>
          new Promise(resolve => {
            resolveRead = resolve
          })
      )
      const { service, advance } = createService({ systemTable: { read } })
      const first = service.snapshot()
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
      resolveRead({
        processes: [systemRow(40, 10, 'c40'), systemRow(41, 40, 'c41')],
        degraded: [],
      })
      await first

      // Hidden for a minute; the first sample on return reuses the old table.
      advance(60_000)
      await service.snapshot({ waitForSystemProcesses: false })
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
      resolveRead({ processes: [systemRow(41, 1, 'c41')], degraded: [] })
      const fresh = await service.snapshot()
      expect(fresh.recentlyExited).toEqual([])
    })

    it('ignores an older collection that resumes after a newer one', async () => {
      const table = mutableTable()
      let release!: (value: (typeof executorProcess)[]) => void
      const held = new Promise<(typeof executorProcess)[]>(resolve => {
        release = resolve
      })
      const hostProcesses = vi.fn().mockReturnValueOnce(held).mockReturnValue([executorProcess])
      const { service, advance } = createService({
        systemTable: { read: table.read },
        hostProcesses,
      })
      const older = service.snapshot()
      await vi.waitFor(() => expect(hostProcesses).toHaveBeenCalledTimes(1))

      advance(1000)
      table.setRows([systemRow(41, 1, 'created-41')])
      const newer = await service.snapshot()
      expect(newer.recentlyExited).toEqual([])

      release([executorProcess])
      await older
      // The resumed older collection must not become the exit baseline.
      advance(1000)
      expect((await service.snapshot()).recentlyExited).toEqual([])
    })

    it('does not report a process as exited when only its descriptor disappears', async () => {
      const table = mutableTable()
      let descriptors: (typeof executorProcess)[] = [{ ...executorProcess, identity: 'executor' }]
      const { service, advance } = createService({
        systemTable: { read: table.read },
        hostProcesses: () => descriptors,
      })
      await service.snapshot()

      advance(1000)
      descriptors = []
      const snapshot = await service.snapshot()
      expect(snapshot.recentlyExited).toEqual([])
      expect(snapshot.processes.filter(row => row.pid === 40).map(row => row.kind)).toEqual([
        'system',
      ])
    })

    it('does not reparent a reused pid onto a lingering parent', async () => {
      const table = mutableTable()
      let descriptors: (typeof executorProcess)[] = [
        { ...executorProcess, identity: 'executor', includeDescendants: true },
      ]
      const { service, advance } = createService({
        systemTable: { read: table.read },
        hostProcesses: () => descriptors,
      })
      await service.snapshot()
      advance(1000)
      descriptors = []
      table.setRows([systemRow(41, 1, 'created-41')])
      await service.snapshot()

      advance(1000)
      table.setRows([{ ...systemRow(41, 1, 'reused'), startedAt: 9000 }])
      const snapshot = await service.snapshot()
      expect(snapshot.processes.map(row => row.pid)).not.toContain(41)
      expect(snapshot.recentlyExited.map(row => row.id)).toEqual(['40:executor', '41:created-41'])
    })

    it('tells a reused pid apart from a process that kept running', async () => {
      const table = mutableTable()
      table.setRows([systemRow(50, 10, 'first')])
      const { service, advance } = createService({ systemTable: { read: table.read } })
      await service.snapshot()

      advance(1000)
      table.setRows([{ ...systemRow(50, 10, 'second'), startedAt: 2000 }])
      const snapshot = await service.snapshot()
      expect(snapshot.processes.map(row => row.id)).toContain('50:second')
      expect(snapshot.recentlyExited.map(row => row.id)).toEqual(['50:first'])
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
