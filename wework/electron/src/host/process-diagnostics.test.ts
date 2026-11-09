import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import {
  classifyElectronProcess,
  collectDescendantProcessIds,
  parseProcessSnapshotLine,
  parseProcessExecutables,
  getElectronProcessSnapshot,
} from './process-diagnostics.js'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: run,
  }),
}))

describe('Electron process diagnostics', () => {
  it('preserves spaces in executable paths without including command arguments', () => {
    expect([
      ...parseProcessExecutables(
        ' 123 /Applications/WeWork Helper.app/Contents/MacOS/WeWork Helper\n 45 /bin/bash\n'
      ),
    ]).toEqual([
      [123, '/Applications/WeWork Helper.app/Contents/MacOS/WeWork Helper'],
      [45, '/bin/bash'],
    ])
  })

  it('parses ps output without losing command arguments', () => {
    expect(
      parseProcessSnapshotLine(
        ' 123  45 6789  12.5 /Applications/WeWork.app/Contents/MacOS/WeWork --flag value'
      )
    ).toEqual({
      pid: 123,
      ppid: 45,
      rss_kib: 6789,
      cpu_percent: 12.5,
      command: '/Applications/WeWork.app/Contents/MacOS/WeWork --flag value',
    })
  })

  it('collects the complete Electron process tree', () => {
    const processes = [
      { pid: 10, ppid: 1, rss_kib: 1, cpu_percent: 0, command: 'main' },
      { pid: 11, ppid: 10, rss_kib: 1, cpu_percent: 0, command: 'renderer' },
      { pid: 12, ppid: 11, rss_kib: 1, cpu_percent: 0, command: 'worker' },
      { pid: 20, ppid: 1, rss_kib: 1, cpu_percent: 0, command: 'unrelated' },
    ]

    expect([...collectDescendantProcessIds(processes, [10])].sort()).toEqual([10, 11, 12])
  })

  it('preserves the established desktop E2E process group names', () => {
    const processInfo = (pid: number, command: string) => ({
      pid,
      ppid: 10,
      rss_kib: 1,
      cpu_percent: 0,
      command,
    })

    expect(classifyElectronProcess(processInfo(10, 'WeWork'), 10)).toBe('main')
    expect(classifyElectronProcess(processInfo(11, 'Electron Helper --type=renderer'), 10)).toBe(
      'webkit-webcontent'
    )
    expect(
      classifyElectronProcess(
        processInfo(12, 'Electron Helper --utility-sub-type=network.mojom.NetworkService'),
        10
      )
    ).toBe('webkit-networking')
    expect(classifyElectronProcess(processInfo(13, '/bin/wegent-executor'), 10)).toBe('executor')
  })
})

describe('physical memory snapshots', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let report: Record<string, unknown>

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    vi.spyOn(process, 'kill').mockReturnValue(true)
    report = {
      unit: 'byte',
      'bytes per unit': 1,
      processes: [
        { pid: 10, footprint: 102_400 },
        { pid: 11, footprint: 256_000 },
        { pid: 99, footprint: 1_024_000 },
      ],
    }
    run.mockReset()
    run.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/bin/footprint') {
        await writeFile(args[args.indexOf('--json') + 1], JSON.stringify(report))
        return { stdout: '', stderr: '' }
      }
      if (args.includes('pid=,ppid=')) {
        return { stdout: '10 1\n11 10\n99 1\n', stderr: '' }
      }
      if (args.includes('pid=,ppid=,rss=,pcpu=,command=')) {
        expect(args).toEqual(['-p', '10,11', '-o', 'pid=,ppid=,rss=,pcpu=,command='])
      }
      return {
        stdout: args.includes('pid=,comm=')
          ? '10 /Applications/WeWork.app/Contents/MacOS/WeWork\n11 /Applications/WeWork Helper\n'
          : '10 1 1000 1.0 WeWork\n11 10 2000 2.0 WeWork --type=renderer\n99 1 9000 3.0 unrelated\n',
        stderr: '',
      }
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.restoreAllMocks()
  })

  it('keeps native physical footprint separate from RSS and limits probing to descendants', async () => {
    const snapshot = await getElectronProcessSnapshot(10)

    expect(
      snapshot.processes.map(({ pid, rss_kib, physical_footprint_kib }) => ({
        pid,
        rss_kib,
        physical_footprint_kib,
      }))
    ).toEqual([
      { pid: 11, rss_kib: 2000, physical_footprint_kib: 250 },
      { pid: 10, rss_kib: 1000, physical_footprint_kib: 100 },
    ])
    expect(snapshot.groups.reduce((sum, group) => sum + group.physical_footprint_kib, 0)).toBe(350)
    const probe = run.mock.calls.find(([command]) => command === '/usr/bin/footprint')
    expect(
      probe?.[1].filter((_: string, index: number, args: string[]) => args[index - 1] === '--pid')
    ).toEqual(['10', '11'])
  })

  it.each([
    { unit: 'page', 'bytes per unit': 16_384 },
    {
      processes: [
        { pid: 10, footprint: -1 },
        { pid: 11, footprint: 256_000 },
      ],
    },
    {
      processes: [
        { pid: 10, footprint: '102400' },
        { pid: 11, footprint: 256_000 },
      ],
    },
    { processes: [{ pid: 11, footprint: 256_000 }] },
  ])('rejects invalid native metrics instead of substituting RSS: %j', async invalid => {
    Object.assign(report, invalid)
    await expect(getElectronProcessSnapshot(10)).rejects.toThrow()
  })

  it('rejects a missing metric for a live descendant', async () => {
    report.processes = [{ pid: 10, footprint: 102_400 }]
    await expect(getElectronProcessSnapshot(10)).rejects.toThrow('11')
  })

  it('excludes a descendant that exits during sampling', async () => {
    report.processes = [{ pid: 10, footprint: 102_400 }]
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('Process exited'), { code: 'ESRCH' })
    })
    const snapshot = await getElectronProcessSnapshot(10)
    expect(snapshot.processes.map(process => process.pid)).toEqual([10])
    expect(snapshot.groups[0].physical_footprint_kib).toBe(100)
  })

  it('does not treat a denied liveness probe as an exited process', async () => {
    report.processes = [{ pid: 10, footprint: 102_400 }]
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' })
    })
    await expect(getElectronProcessSnapshot(10)).rejects.toThrow('11')
  })
})
