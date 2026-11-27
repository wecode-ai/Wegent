import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { processes as readSystemProcesses, type Systeminformation } from 'systeminformation'
import type { SystemProcessInfo } from '../core/build-snapshot.js'
import { resolveProcessName } from './process-name.js'
import {
  describeError,
  type SystemProcessTable,
  type SystemProcessTableResult,
} from './system-process-table.js'

export type SystemInformationProcessesReader = () => Promise<Systeminformation.ProcessesData>

interface LinuxProcessMetadata {
  name: string
  startedAt: number
}

type LinuxProcessMetadataReader = () => Promise<Map<number, LinuxProcessMetadata> | null>

/**
 * `systeminformation` guesses executable names from command lines and derives
 * start times from rounded elapsed times. One `ps` call supplies the kernel
 * name and the absolute start time for a stable process identity.
 */
const readLinuxProcessMetadata: LinuxProcessMetadataReader = async () => {
  return new Promise(resolve => {
    execFile(
      'ps',
      ['-axo', 'pid=,lstart=,comm='],
      { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        const processes = error ? null : parseLinuxProcessMetadata(stdout)
        resolve(processes?.size ? processes : null)
      }
    )
  })
}

/** Parses `ps -axo pid=,lstart=,comm=` with English UTC timestamps. */
export function parseLinuxProcessMetadata(output: string): Map<number, LinuxProcessMetadata> {
  const processes = new Map<number, LinuxProcessMetadata>()
  for (const line of output.split('\n')) {
    // `comm` may contain spaces, so everything after the timestamp is the name.
    const match =
      /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/.exec(line)
    if (!match) continue
    const [, pid, timestamp, name] = match
    const startedAt = Date.parse(`${timestamp} UTC`)
    if (Number.isFinite(startedAt)) processes.set(Number(pid), { name, startedAt })
  }
  return processes
}

/**
 * Cross-platform process table backed by `systeminformation`. It owns the
 * per-OS collection differences (`ps` on Unix, CIM on Windows, and the other
 * supported platforms), so WeWork only maps its stable process shape.
 */
export class SystemInformationProcessTable implements SystemProcessTable {
  constructor(
    private readonly readProcesses: SystemInformationProcessesReader = readSystemProcesses,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly cpuCount: number = cpus().length,
    private readonly readLinuxMetadata: LinuxProcessMetadataReader = readLinuxProcessMetadata
  ) {}

  async read(): Promise<SystemProcessTableResult> {
    try {
      const data = await this.readProcesses()
      const linuxMetadata = this.platform === 'linux' ? await this.readLinuxMetadata() : null
      const processes = data.list
        .filter(row => Number.isInteger(row.pid) && row.pid > 0)
        .filter(row => !isInternalPowerShell(row) && !isInternalProcessCollector(row))
        // A process missing from the later kernel read has already left the table.
        .filter(row => !linuxMetadata || linuxMetadata.has(row.pid))
        .map(row => {
          const metadata = linuxMetadata?.get(row.pid)
          const process = toSystemProcessInfo(row, this.platform, this.cpuCount, metadata?.name)
          return metadata
            ? { ...process, startedAt: metadata.startedAt, identity: String(metadata.startedAt) }
            : process
        })
      return {
        processes,
        degraded:
          this.platform === 'linux' && !linuxMetadata
            ? [
                {
                  code: 'system-process-table-failed',
                  detail: 'Linux process metadata unavailable',
                },
              ]
            : [],
      }
    } catch (error) {
      return {
        processes: [],
        degraded: [{ code: 'system-process-table-failed', detail: describeError(error) }],
      }
    }
  }
}

export function toSystemProcessInfo(
  row: Systeminformation.ProcessesProcessData,
  platform: NodeJS.Platform = process.platform,
  cpuCount: number = cpus().length,
  kernelName: string | null = null
): SystemProcessInfo {
  const command = launchDetail(row, platform)
  return {
    pid: row.pid,
    parentPid: Number.isFinite(row.parentPid) ? row.parentPid : 0,
    name: kernelName ? resolveProcessName(command ?? '', kernelName) : displayName(row),
    command,
    cpuPercent: normalizeCpuPercent(row.cpu, platform, cpuCount),
    // `memRss` is KiB on every platform supported by systeminformation.
    memoryBytes: Number.isFinite(row.memRss) ? Math.round(row.memRss * 1024) : null,
    startedAt: parseStartedAt(row.started),
    identity: row.started?.trim() || '',
  }
}

/**
 * systeminformation reports Windows and Linux CPU as a share of total CPU
 * capacity, while Electron reports per-core percentages. Scale those platforms
 * so the explorer and its summary never add values with different meanings.
 * macOS and the BSDs already use `ps` per-core percentages.
 */
function normalizeCpuPercent(
  value: number,
  platform: NodeJS.Platform,
  cpuCount: number
): number | null {
  if (!Number.isFinite(value)) return null
  const cores = Math.max(1, Math.floor(cpuCount))
  if (cores > 1 && (platform === 'win32' || platform === 'linux')) return value * cores
  return value
}

/**
 * `systeminformation` runs its Windows query through PowerShell. It is an
 * implementation detail of collection, not a WeWork process, so hide that
 * collector command from the explorer.
 */
export function isInternalPowerShell(row: Systeminformation.ProcessesProcessData): boolean {
  const name = row.name.toLowerCase()
  if (
    name !== 'powershell' &&
    name !== 'powershell.exe' &&
    name !== 'pwsh' &&
    name !== 'pwsh.exe'
  ) {
    return false
  }
  const command = [row.command, row.params].filter(Boolean).join(' ')
  const collectorQuery =
    command.includes('Get-CimInstance Win32_Process') && command.includes('ConvertTo-Json')
  const persistentHost =
    /-NoProfile\b/.test(command) &&
    /-NoLogo\b/.test(command) &&
    /-InputFormat\s+Text\b/.test(command) &&
    /-NoExit\b/.test(command) &&
    /-Command\s+-/.test(command)
  return collectorQuery || persistentHost
}

/**
 * On Unix, systeminformation shells out to `ps`. The command is part of the
 * table it returns, so hide the exact collector invocation as well.
 */
export function isInternalProcessCollector(row: Systeminformation.ProcessesProcessData): boolean {
  const command = [row.command, row.params].filter(Boolean).join(' ')
  return (
    /\bps\s+-axo\b/.test(command) &&
    (command.includes('temp_title_') || command.includes('export LC_ALL=C'))
  )
}

export function parseStartedAt(value: string): number | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const parsed = Date.parse(trimmed.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : null
}

function launchDetail(
  row: Systeminformation.ProcessesProcessData,
  platform: NodeJS.Platform
): string | null {
  const command = row.command?.trim() ?? ''
  const params = row.params?.trim() ?? ''
  const executable =
    platform === 'win32' ? command : joinExecutablePath(row.path?.trim() ?? '', command)
  return [executable, params].filter(Boolean).join(' ') || null
}

function joinExecutablePath(path: string, command: string): string {
  if (!path || !command || command.startsWith('/') || command.startsWith('.')) return command
  return `${path.replace(/[\\/]+$/, '')}/${command}`
}

function displayName(row: Systeminformation.ProcessesProcessData): string {
  const name = row.name?.trim()
  if (name) return name
  const source = row.path?.trim() || row.command?.trim()
  if (!source) return `PID ${row.pid}`
  const executable = source.split(/[\\/]/).pop()
  return executable || `PID ${row.pid}`
}
