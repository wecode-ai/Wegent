import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ProcessDiagnosticsProcess {
  pid: number
  ppid: number
  group: string
  rss_kib: number
  physical_footprint_kib: number
  cpu_percent: number
  command: string
  executable: string | null
}

export interface ProcessDiagnosticsGroup {
  group: string
  process_count: number
  rss_kib: number
  physical_footprint_kib: number
  cpu_percent: number
  pids: number[]
}

export interface ProcessDiagnosticsSnapshot {
  timestamp_ms: number
  main_pid: number
  groups: ProcessDiagnosticsGroup[]
  processes: ProcessDiagnosticsProcess[]
}

interface RawProcessInfo {
  pid: number
  ppid: number
  rss_kib: number
  cpu_percent: number
  command: string
}

export function parseProcessSnapshotLine(line: string): RawProcessInfo | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/)
  if (!match) return null
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    rss_kib: Number(match[3]),
    cpu_percent: Number(match[4]),
    command: match[5],
  }
}

export function collectDescendantProcessIds(
  processes: Pick<RawProcessInfo, 'pid' | 'ppid'>[],
  roots: number[]
): Set<number> {
  const childrenByParent = new Map<number, number[]>()
  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.ppid) ?? []
    children.push(processInfo.pid)
    childrenByParent.set(processInfo.ppid, children)
  }

  const descendants = new Set<number>()
  const pending = [...roots]
  while (pending.length > 0) {
    const pid = pending.pop()
    if (pid === undefined || descendants.has(pid)) continue
    descendants.add(pid)
    pending.push(...(childrenByParent.get(pid) ?? []))
  }
  return descendants
}

export function parseProcessExecutables(output: string): Map<number, string> {
  const executables = new Map<number, string>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (match) executables.set(Number(match[1]), match[2])
  }
  return executables
}

export function classifyElectronProcess(processInfo: RawProcessInfo, mainPid: number): string {
  if (processInfo.pid === mainPid) return 'main'
  if (processInfo.command.includes('wegent-executor')) return 'executor'
  if (processInfo.command.includes('codex') && processInfo.command.includes('app-server')) {
    return 'codex-app-server'
  }
  if (processInfo.command.includes('--type=renderer')) return 'webkit-webcontent'
  if (processInfo.command.includes('--type=gpu-process')) return 'webkit-gpu'
  if (processInfo.command.includes('network.mojom.NetworkService')) {
    return 'webkit-networking'
  }
  if (processInfo.command.includes('--type=utility')) return 'webkit-other'
  return 'child'
}

async function readPhysicalFootprints(pids: number[]): Promise<Map<number, number>> {
  const directory = await mkdtemp(join(tmpdir(), 'wework-process-footprint-'))
  try {
    const reportPath = join(directory, 'footprint.json')
    await execFileAsync(
      '/usr/bin/footprint',
      [
        '--noCategories',
        '--format',
        'bytes',
        '--json',
        reportPath,
        ...pids.flatMap(pid => ['--pid', String(pid)]),
      ],
      { timeout: 10_000 }
    )
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    if (
      report?.unit !== 'byte' ||
      report['bytes per unit'] !== 1 ||
      !Array.isArray(report.processes)
    ) {
      throw new Error('Invalid native physical footprint report')
    }
    const footprints = new Map<number, number>()
    for (const entry of report.processes) {
      if (
        !Number.isSafeInteger(entry?.pid) ||
        entry.pid <= 0 ||
        !Number.isSafeInteger(entry.footprint) ||
        entry.footprint < 0 ||
        footprints.has(entry.pid)
      ) {
        throw new Error('Invalid native physical footprint process metric')
      }
      footprints.set(entry.pid, entry.footprint / 1024)
    }
    return footprints
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function hasExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export async function getElectronProcessSnapshot(
  mainPid = process.pid
): Promise<ProcessDiagnosticsSnapshot> {
  if (process.platform !== 'darwin') {
    throw new Error('Process diagnostics are currently available only on macOS')
  }
  const { stdout: topology } = await execFileAsync('ps', ['-axo', 'pid=,ppid='])
  const parents = topology.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]) }] : []
  })
  const relatedProcessIds = collectDescendantProcessIds(parents, [mainPid])
  const { stdout } = await execFileAsync('ps', [
    '-p',
    [...relatedProcessIds].join(','),
    '-o',
    'pid=,ppid=,rss=,pcpu=,command=',
  ])
  const allProcesses = stdout
    .split('\n')
    .map(parseProcessSnapshotLine)
    .filter((value): value is RawProcessInfo => value !== null)
  const footprints = await readPhysicalFootprints([...relatedProcessIds])
  for (const pid of relatedProcessIds) {
    if (footprints.has(pid)) continue
    if (pid !== mainPid && hasExited(pid)) {
      relatedProcessIds.delete(pid)
      continue
    }
    throw new Error(`Missing native physical footprint for process ${pid}`)
  }
  const { stdout: executableOutput } = await execFileAsync('ps', [
    '-p',
    [...relatedProcessIds].join(','),
    '-o',
    'pid=,comm=',
  ])
  const executables = parseProcessExecutables(executableOutput)
  const processes = allProcesses
    .filter(processInfo => relatedProcessIds.has(processInfo.pid))
    .map(processInfo => ({
      ...processInfo,
      executable: executables.get(processInfo.pid) ?? null,
      group: classifyElectronProcess(processInfo, mainPid),
      physical_footprint_kib: footprints.get(processInfo.pid)!,
    }))
    .sort((left, right) => right.physical_footprint_kib - left.physical_footprint_kib)

  const groupsByName = new Map<string, ProcessDiagnosticsGroup>()
  for (const processInfo of processes) {
    const group = groupsByName.get(processInfo.group) ?? {
      group: processInfo.group,
      process_count: 0,
      rss_kib: 0,
      physical_footprint_kib: 0,
      cpu_percent: 0,
      pids: [],
    }
    group.process_count += 1
    group.rss_kib += processInfo.rss_kib
    group.physical_footprint_kib += processInfo.physical_footprint_kib
    group.cpu_percent += processInfo.cpu_percent
    group.pids.push(processInfo.pid)
    groupsByName.set(processInfo.group, group)
  }

  return {
    timestamp_ms: Date.now(),
    main_pid: mainPid,
    groups: [...groupsByName.values()].sort(
      (left, right) => right.physical_footprint_kib - left.physical_footprint_kib
    ),
    processes,
  }
}
