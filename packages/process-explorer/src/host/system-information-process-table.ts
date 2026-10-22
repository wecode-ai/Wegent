import { cpus } from 'node:os'
import { processes as readSystemProcesses, type Systeminformation } from 'systeminformation'
import type { SystemProcessInfo } from '../core/build-snapshot.js'
import {
  describeError,
  type SystemProcessTable,
  type SystemProcessTableResult,
} from './system-process-table.js'

export type SystemInformationProcessesReader = () => Promise<Systeminformation.ProcessesData>

/**
 * Cross-platform process table backed by `systeminformation`. It owns the
 * per-OS collection differences (`ps` on Unix, CIM on Windows, and the other
 * supported platforms), so WeWork only maps its stable process shape.
 */
export class SystemInformationProcessTable implements SystemProcessTable {
  constructor(
    private readonly readProcesses: SystemInformationProcessesReader = readSystemProcesses,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly cpuCount: number = cpus().length
  ) {}

  async read(): Promise<SystemProcessTableResult> {
    try {
      const data = await this.readProcesses()
      const processes = data.list
        .filter(row => Number.isInteger(row.pid) && row.pid > 0)
        .filter(row => !isInternalPowerShell(row) && !isInternalProcessCollector(row))
        .map(row => toSystemProcessInfo(row, this.platform, this.cpuCount))
      return { processes, degraded: [] }
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
  cpuCount: number = cpus().length
): SystemProcessInfo {
  const command = launchDetail(row, platform)
  return {
    pid: row.pid,
    parentPid: Number.isFinite(row.parentPid) ? row.parentPid : 0,
    name: displayName(row),
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
