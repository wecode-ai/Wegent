import { readFileSync } from 'node:fs'
import type { Systeminformation } from 'systeminformation'
import { describe, expect, it, vi } from 'vitest'
import {
  SystemInformationProcessTable,
  isInternalPowerShell,
  parseLinuxProcessMetadata,
  parseStartedAt,
} from './system-information-process-table'

describe('systeminformation process table', () => {
  it('maps the cross-platform process shape to the explorer contract', async () => {
    const started = '2026-10-20 00:15:30'
    const read = vi.fn(async () =>
      processesData([
        processRow({
          pid: 42,
          parentPid: 7,
          name: 'Helper',
          cpu: 12.5,
          memRss: 2048,
          started,
          command: 'Helper',
          params: '--type=renderer',
          path: '/Applications/WeWork.app/Contents/Frameworks',
        }),
      ])
    )
    const table = new SystemInformationProcessTable(read, 'darwin')

    const result = await table.read()

    expect(result.degraded).toEqual([])
    expect(result.processes).toEqual([
      {
        pid: 42,
        parentPid: 7,
        name: 'Helper',
        command: '/Applications/WeWork.app/Contents/Frameworks/Helper --type=renderer',
        cpuPercent: 12.5,
        memoryBytes: 2048 * 1024,
        startedAt: new Date('2026-10-20T00:15:30').getTime(),
        identity: started,
      },
    ])
  })

  it('keeps the full Windows launch detail for later normalization', async () => {
    const row = processRow({
      pid: 8,
      name: 'conhost.exe',
      command: '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4',
      path: 'C:\\WINDOWS\\system32\\conhost.exe',
    })
    const table = new SystemInformationProcessTable(async () => processesData([row]), 'win32', 8)

    const result = await table.read()

    expect(result.processes[0]?.command).toBe('\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4')
  })

  it('normalizes Windows CPU shares to per-core percentages', async () => {
    const row = processRow({ pid: 8, cpu: 12.5 })
    const table = new SystemInformationProcessTable(async () => processesData([row]), 'win32', 8)

    const result = await table.read()

    expect(result.processes[0]?.cpuPercent).toBe(100)
  })

  it('corrects Linux names the command-line heuristic misread from the kernel name', async () => {
    const row = processRow({
      pid: 42,
      name: 'Wegent.git',
      command: 'Wegent.git',
      params: '',
      path: '/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core/git-remote-https fork https://github.com/sleepdrop/',
    })
    const readLinuxMetadata = vi.fn(
      async () => new Map([[42, { name: 'git-remote-http', startedAt: 1 }]])
    )
    const table = new SystemInformationProcessTable(
      async () => processesData([row]),
      'linux',
      8,
      readLinuxMetadata
    )

    const result = await table.read()

    expect(result.processes[0]?.name).toBe('git-remote-https')
    expect(readLinuxMetadata).toHaveBeenCalledOnce()
  })

  it('keeps a Linux process identity stable when the elapsed-time estimate drifts', async () => {
    let estimatedStart = '2026-10-20 00:00:01'
    let startedAt = Date.UTC(2026, 9, 20)
    const table = new SystemInformationProcessTable(
      async () => processesData([processRow({ pid: 42, started: estimatedStart })]),
      'linux',
      8,
      async () => new Map([[42, { name: 'node', startedAt }]])
    )

    const first = (await table.read()).processes[0]
    estimatedStart = '2026-10-20 00:00:03'
    const second = (await table.read()).processes[0]

    expect(first?.startedAt).toBe(startedAt)
    expect(second?.identity).toBe(first?.identity)
    expect(second?.startedAt).toBe(startedAt)

    startedAt += 10_000
    const reusedPid = (await table.read()).processes[0]
    expect(reusedPid?.startedAt).toBe(startedAt)
    expect(reusedPid?.identity).not.toBe(first?.identity)
  })

  it('keeps the available process rows and reports missing Linux metadata', async () => {
    const table = new SystemInformationProcessTable(
      async () => processesData([processRow({ pid: 42, name: 'node' })]),
      'linux',
      8,
      async () => null
    )
    const result = await table.read()
    expect(result.processes[0]?.name).toBe('node')
    expect(result.degraded).toEqual([
      { code: 'system-process-table-failed', detail: 'Linux process metadata unavailable' },
    ])
  })

  it('parses Linux kernel names and absolute start times', () => {
    expect([
      ...parseLinuxProcessMetadata(
        '   1 Fri Nov 27 06:49:30 2026 systemd\n 742 Tue Dec  1 04:03:02 2026 git-remote-http\n' +
          '  42 Fri Nov 27 06:50:36 2026 WeWork Helper  \n\n bad line\n'
      ),
    ]).toEqual([
      [1, { name: 'systemd', startedAt: Date.UTC(2026, 10, 27, 6, 49, 30) }],
      [742, { name: 'git-remote-http', startedAt: Date.UTC(2026, 11, 1, 4, 3, 2) }],
      [42, { name: 'WeWork Helper', startedAt: Date.UTC(2026, 10, 27, 6, 50, 36) }],
    ])
  })

  // The only coverage that runs a real process table; ubuntu CI executes it.
  it.skipIf(process.platform !== 'linux')('resolves the live Linux table', async () => {
    const table = new SystemInformationProcessTable(undefined, 'linux')
    const result = await table.read()
    expect(result.degraded).toEqual([])
    const kernelName = readFileSync('/proc/self/comm', 'utf8').trim()
    const self = result.processes.find(row => row.pid === process.pid)
    expect(self?.name === kernelName || self?.name?.startsWith(kernelName)).toBe(true)
    expect(self?.startedAt).toBeGreaterThan(0)
    const nextSelf = (await table.read()).processes.find(row => row.pid === process.pid)
    expect(nextSelf?.identity).toBe(self?.identity)
  })

  it('hides the ps collector used by systeminformation on Unix', async () => {
    const collector = processRow({
      pid: 11,
      name: 'ps',
      command: 'ps',
      params:
        '-axo pid,ppid,pcpu,pmem,pri,vsz=temp_title_1,rss=temp_title_2,nice,etime=temp_title_3,state,tty,user,command -r',
    })
    const table = new SystemInformationProcessTable(
      async () => processesData([collector, processRow({ pid: 12 })]),
      'darwin'
    )

    const result = await table.read()

    expect(result.processes.map(row => row.pid)).toEqual([12])
  })

  it('hides the PowerShell host used by systeminformation', async () => {
    const host = processRow({
      pid: 9,
      name: 'powershell.exe',
      command: 'powershell.exe -NoProfile -NoLogo -InputFormat Text -NoExit -Command -',
    })
    const table = new SystemInformationProcessTable(
      async () => processesData([host, processRow({ pid: 10 })]),
      'win32'
    )

    const result = await table.read()

    expect(result.processes.map(row => row.pid)).toEqual([10])
    expect(isInternalPowerShell(host)).toBe(true)
    expect(
      isInternalPowerShell(
        processRow({
          name: 'powershell.exe',
          command:
            'powershell.exe -NoProfile -NoLogo -Command Get-CimInstance Win32_Process | ConvertTo-Json',
        })
      )
    ).toBe(true)
  })

  it('reports collection failures as degradation', async () => {
    const table = new SystemInformationProcessTable(async () => {
      throw new Error('ps failed')
    })

    const result = await table.read()

    expect(result.processes).toEqual([])
    expect(result.degraded).toEqual([{ code: 'system-process-table-failed', detail: 'ps failed' }])
  })

  it('ignores invalid start times', () => {
    expect(parseStartedAt('')).toBeNull()
    expect(parseStartedAt('not-a-date')).toBeNull()
    expect(parseStartedAt('2026-10-20 00:15:30')).toBe(new Date('2026-10-20T00:15:30').getTime())
  })
})

function processesData(
  list: Systeminformation.ProcessesProcessData[]
): Systeminformation.ProcessesData {
  return {
    all: list.length,
    running: 0,
    blocked: 0,
    sleeping: list.length,
    unknown: 0,
    list,
  }
}

function processRow(
  overrides: Partial<Systeminformation.ProcessesProcessData>
): Systeminformation.ProcessesProcessData {
  return {
    pid: 1,
    parentPid: 0,
    name: 'node',
    cpu: 1,
    cpuu: 0,
    cpus: 1,
    mem: 0.1,
    priority: 0,
    memVsz: 1024,
    memRss: 1024,
    nice: 0,
    started: '2026-10-20 00:00:00',
    state: 'sleeping',
    tty: '',
    user: 'user',
    command: 'node',
    params: '',
    path: '',
    ...overrides,
  }
}
