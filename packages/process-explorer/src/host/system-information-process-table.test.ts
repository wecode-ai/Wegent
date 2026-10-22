import type { Systeminformation } from 'systeminformation'
import { describe, expect, it, vi } from 'vitest'
import {
  SystemInformationProcessTable,
  isInternalPowerShell,
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
