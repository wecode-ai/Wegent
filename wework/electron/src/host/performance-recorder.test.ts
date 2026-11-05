import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RotatingLog } from '../runtime/rotating-log.js'
import type { ProcessSnapshot } from '../vendor/process-explorer/contract.js'
import { PerformanceRecorder } from './performance-recorder.js'

const mocks = vi.hoisted(() => ({ mem: vi.fn() }))
vi.mock('systeminformation', () => ({ mem: mocks.mem }))

const snapshot: ProcessSnapshot = {
  capturedAt: 123456,
  platform: 'win32',
  applicationPid: 100,
  processes: [
    {
      id: '100:private-task-identity',
      pid: 100,
      parentPid: 1,
      kind: 'application',
      source: 'electron',
      owner: { id: 'application', label: 'Private title', key: 'application' },
      name: 'Private title',
      detail: '/private/project --token secret-value',
      cpuPercent: 22,
      memoryBytes: 123000,
      idleWakeupsPerSecond: 0,
      startedAt: 123,
    },
  ],
  degraded: [{ code: 'renderer-labels-failed', detail: 'private-path' }],
}

describe('PerformanceRecorder', () => {
  let directory: string
  let recorder: PerformanceRecorder

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    mocks.mem.mockReset().mockResolvedValue({
      total: 16000,
      free: 100,
      available: 200,
      active: 15800,
      swaptotal: 8000,
      swapused: 7000,
      swapfree: 1000,
    })
    directory = await mkdtemp(join(tmpdir(), 'wework-performance-'))
  })

  afterEach(async () => {
    await recorder?.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
    await rm(directory, { recursive: true, force: true })
  })

  function create(processSnapshot = vi.fn().mockResolvedValue(snapshot)) {
    recorder = new PerformanceRecorder({
      logPath: join(directory, 'performance.log'),
      appVersion: '0.5.13',
      processSnapshot,
    })
    return processSnapshot
  }

  async function records() {
    const contents = await readFile(join(directory, 'performance.log'), 'utf8')
    return contents
      .trim()
      .split('\n')
      .map(line => JSON.parse(line.slice(line.indexOf('{'))))
  }

  async function waitForSamples(count: number) {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const values = await records()
      // File visibility can precede append completion and the next sample timer.
      if (
        values.filter(value => value.type === 'performance-sample').length >= count &&
        vi.getTimerCount() === 1
      )
        return
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    throw new Error(`Expected ${count} recorded performance samples`)
  }

  test('starts disabled and writes nothing until the device preference enables recording', async () => {
    const processSnapshot = create()
    await vi.advanceTimersByTimeAsync(30_000)
    await recorder.stop()
    expect(processSnapshot).not.toHaveBeenCalled()
    expect(mocks.mem).not.toHaveBeenCalled()
    expect(await readdir(directory)).toEqual([])
  })

  test('persists an immediate sample with system pressure and process metrics but no content', async () => {
    create()
    await recorder.setEnabled(true)
    await recorder.stop()
    const values = await records()
    expect(values.map(value => value.type)).toEqual([
      'recording-started',
      'performance-sample',
      'recording-stopped',
    ])
    expect(values[1]).toMatchObject({
      schemaVersion: 1,
      appVersion: '0.5.13',
      applicationPid: 100,
      processSnapshotCapturedAt: 123456,
      system: {
        memoryTotalBytes: 16000,
        memoryAvailableBytes: 200,
        memoryActiveBytes: 15800,
        swapTotalBytes: 8000,
        swapUsedBytes: 7000,
      },
      processes: [{ pid: 100, owner: 'application', cpuPercent: 22, memoryBytes: 123000 }],
      degraded: ['renderer-labels-failed'],
    })
    expect(JSON.stringify(values)).not.toMatch(/Private|private-|secret-value|token/)
  })

  test('keeps safe OS executable basenames while excluding titles and command arguments', async () => {
    create(
      vi.fn().mockResolvedValue({
        ...snapshot,
        processes: [
          snapshot.processes[0],
          {
            ...snapshot.processes[0],
            source: 'system',
            kind: 'host-child',
            name: 'C:\\private-project\\python.exe',
          },
          { ...snapshot.processes[0], source: 'system', name: '/private-project/node' },
          { ...snapshot.processes[0], source: 'system', name: 'node --token secret-value' },
          { ...snapshot.processes[0], kind: 'window', source: 'system', name: 'Prompt' },
          { ...snapshot.processes[0], source: 'host', name: 'Executor' },
        ],
      })
    )
    await recorder.setEnabled(true)
    await recorder.stop()
    expect(
      (await records())[1].processes.map(
        (value: { executableName: string | null }) => value.executableName
      )
    ).toEqual([null, 'python.exe', 'node', null, null, null])
    expect(JSON.stringify(await records())).not.toMatch(/private-project|Prompt|secret-value/)
  })

  test('opening twice is idempotent, periodic samples wait five seconds, and disabling stops them', async () => {
    const processSnapshot = create()
    await recorder.setEnabled(true)
    await recorder.setEnabled(true)
    await waitForSamples(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(processSnapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await waitForSamples(2)
    expect(processSnapshot).toHaveBeenCalledTimes(2)
    await recorder.setEnabled(false)
    await recorder.setEnabled(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(processSnapshot).toHaveBeenCalledTimes(2)
    expect((await records()).filter(value => value.type === 'recording-stopped')).toHaveLength(1)
  })

  test('disabling waits for the in-flight sample and leaves it on disk', async () => {
    let complete!: (value: ProcessSnapshot) => void
    const processSnapshot = create(vi.fn(() => new Promise(resolve => (complete = resolve))))
    await recorder.setEnabled(true)
    let stopped = false
    const stopping = recorder.stop().then(() => (stopped = true))
    await Promise.resolve()
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(processSnapshot).toHaveBeenCalledTimes(1)
    complete(snapshot)
    await stopping
    expect((await records()).filter(value => value.type === 'performance-sample')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(processSnapshot).toHaveBeenCalledTimes(1)
  })

  test('retains system metrics when process collection fails and recovers on the next sample', async () => {
    create(vi.fn().mockRejectedValueOnce(new Error('private-query')).mockResolvedValue(snapshot))
    await recorder.setEnabled(true)
    await waitForSamples(1)
    expect((await records())[1]).toMatchObject({
      system: { memoryAvailableBytes: 200 },
      processes: [],
      degraded: ['process-snapshot-failed'],
    })
    await vi.advanceTimersByTimeAsync(5000)
    await waitForSamples(2)
    await recorder.stop()
    expect((await records())[2].processes).toHaveLength(1)
    expect(JSON.stringify(await records())).not.toContain('private-query')
  })

  test('bounded collection timeout keeps a hung collector from accumulating or blocking stop', async () => {
    const processSnapshot = create(vi.fn(() => new Promise(() => undefined)))
    await recorder.setEnabled(true)
    await vi.advanceTimersByTimeAsync(10_000)
    await waitForSamples(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(processSnapshot).toHaveBeenCalledTimes(1)
    const stopping = recorder.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    await stopping
    expect((await records()).filter(value => value.type === 'performance-sample')).toHaveLength(2)
  })

  test('reuses timed-out collectors without delaying later samples and recovers when they settle', async () => {
    const recoveredSnapshot = { ...snapshot, capturedAt: 987654, degraded: [] }
    const recoveredMemory = {
      total: 32000,
      free: 8000,
      available: 9000,
      active: 23000,
      swaptotal: 8000,
      swapused: 1000,
      swapfree: 7000,
    }
    let completeProcesses!: (value: ProcessSnapshot) => void
    const pendingProcesses = new Promise<ProcessSnapshot>(resolve => {
      completeProcesses = resolve
    })
    let completeMemory!: (value: typeof recoveredMemory) => void
    const pendingMemory = new Promise<typeof recoveredMemory>(resolve => {
      completeMemory = resolve
    })
    const processSnapshot = create(
      vi.fn().mockReturnValueOnce(pendingProcesses).mockResolvedValue(recoveredSnapshot)
    )
    mocks.mem.mockReturnValueOnce(pendingMemory).mockResolvedValue(recoveredMemory)

    try {
      await recorder.setEnabled(true)
      const startedAt = Date.now()
      await vi.advanceTimersByTimeAsync(10_000)
      await waitForSamples(1)
      for (let count = 2; count <= 4; count += 1) {
        await vi.advanceTimersByTimeAsync(5000)
        await waitForSamples(count)
        expect(processSnapshot).toHaveBeenCalledOnce()
        expect(mocks.mem).toHaveBeenCalledOnce()
      }
      const degradedSamples = (await records()).filter(value => value.type === 'performance-sample')
      expect(degradedSamples.map(value => value.timestamp - startedAt)).toEqual([
        10_000, 15_000, 20_000, 25_000,
      ])
      expect(
        degradedSamples.every(
          value =>
            value.processes.length === 0 &&
            value.system.memoryActiveBytes === null &&
            value.degraded.includes('process-snapshot-failed') &&
            value.degraded.includes('system-memory-failed')
        )
      ).toBe(true)

      completeProcesses(recoveredSnapshot)
      completeMemory(recoveredMemory)
      await vi.advanceTimersByTimeAsync(5000)
      await waitForSamples(5)
      expect(processSnapshot).toHaveBeenCalledTimes(2)
      expect(mocks.mem).toHaveBeenCalledTimes(2)
      expect((await records()).at(-1)).toMatchObject({
        timestamp: startedAt + 30_000,
        processSnapshotCapturedAt: recoveredSnapshot.capturedAt,
        system: {
          memoryTotalBytes: 32000,
          memoryAvailableBytes: 9000,
          memoryActiveBytes: 23000,
          swapUsedBytes: 1000,
        },
        processes: [{ pid: 100, memoryBytes: 123000 }],
        degraded: [],
      })
    } finally {
      completeProcesses(recoveredSnapshot)
      completeMemory(recoveredMemory)
      await recorder.stop()
    }
  })

  test('reports the first write failure and permits a later retry without a poisoned log queue', async () => {
    const processSnapshot = create()
    await mkdir(join(directory, 'performance.log'))
    await expect(recorder.setEnabled(true)).rejects.toThrow()
    expect(processSnapshot).not.toHaveBeenCalled()
    await rm(join(directory, 'performance.log'), { recursive: true })
    await recorder.setEnabled(true)
    await recorder.stop()
    expect((await records()).map(value => value.type)).toEqual([
      'recording-started',
      'performance-sample',
      'recording-stopped',
    ])
  })

  test('retains physical memory readings when the extended memory collector fails', async () => {
    mocks.mem.mockRejectedValue(new Error('private-memory-query'))
    create()
    await recorder.setEnabled(true)
    await recorder.stop()
    expect((await records())[1]).toMatchObject({
      system: {
        memoryTotalBytes: expect.any(Number),
        memoryAvailableBytes: expect.any(Number),
        memoryActiveBytes: null,
        swapUsedBytes: null,
      },
      degraded: ['renderer-labels-failed', 'system-memory-failed'],
    })
  })

  test('recovers from a sample write failure and records the collection gap', async () => {
    const write = vi.spyOn(RotatingLog.prototype, 'write')
    const original = write.getMockImplementation()!
    write.mockImplementationOnce(original).mockRejectedValueOnce(new Error('disk-full'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    create()
    await recorder.setEnabled(true)
    for (let attempt = 0; attempt < 2000 && !warning.mock.calls.length; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    expect(warning).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    await waitForSamples(1)
    await recorder.stop()
    expect((await records())[1].degraded).toContain('previous-log-write-failed')
  })

  test('bounds process records and retains parseable JSON instead of truncating a sample', async () => {
    create(
      vi.fn().mockResolvedValue({
        ...snapshot,
        processes: Array.from({ length: 3000 }, (_, index) => ({
          ...snapshot.processes[0],
          pid: index + 1,
          owner: { id: 'workbench:private-title', label: 'Private title' },
        })),
      })
    )
    await recorder.setEnabled(true)
    await recorder.stop()
    const sample = (await records())[1]
    expect(sample.processCount).toBe(3000)
    expect(sample.processes.length).toBeGreaterThan(0)
    expect(sample.processes.length + sample.omittedProcessCount).toBe(3000)
    expect(sample.processes.every((value: { owner: string }) => value.owner === 'workbench')).toBe(
      true
    )
    expect((await stat(join(directory, 'performance.log'))).size).toBeLessThan(256 * 1024 + 1024)
  })

  test('rotates bounded logs while retaining previous application sessions', async () => {
    const write = vi.spyOn(RotatingLog.prototype, 'write')
    create(
      vi.fn().mockResolvedValue({
        ...snapshot,
        processes: Array.from({ length: 1000 }, (_, index) => ({
          ...snapshot.processes[0],
          pid: index + 1,
        })),
      })
    )
    await recorder.setEnabled(true)
    await waitForSamples(1)
    for (let index = 0; index < 160; index += 1) {
      const before = write.mock.calls.length
      await vi.advanceTimersByTimeAsync(5000)
      for (let attempt = 0; attempt < 2000 && write.mock.calls.length === before; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      await write.mock.results.at(-1)?.value
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    await recorder.stop()
    const names = await readdir(directory)
    expect(names).toContain('performance.log.1')
    expect(names).toHaveLength(4)
    for (const name of names) {
      expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(5 * 1024 * 1024)
      const lines = (await readFile(join(directory, name), 'utf8')).trim().split('\n')
      expect(lines.every(line => JSON.parse(line.slice(line.indexOf('{'))))).toBe(true)
    }
    const previous = await readFile(join(directory, 'performance.log'), 'utf8')
    create()
    await recorder.setEnabled(true)
    await recorder.stop()
    expect(await readFile(join(directory, 'performance.log'), 'utf8')).toMatch(previous)
    expect((await records()).at(-3).type).toBe('recording-started')
  })
})
