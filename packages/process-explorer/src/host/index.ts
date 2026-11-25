import { SystemInformationProcessTable } from './system-information-process-table.js'
import { MacosProcessTable } from './macos-process-table.js'
import type { SystemProcessTable } from './system-process-table.js'

export {
  createElectronMetricsSource,
  readRendererProcesses,
  type ElectronMetricsHost,
  type ElectronMetricsReader,
  type ElectronMetricsSource,
  type RendererContentsLike,
} from './electron-metrics.js'
export { ProcessExplorerService, type ProcessExplorerServiceOptions } from './service.js'
export {
  MacosProcessTable,
  parsePsLine,
  resolveProcessName,
  type PsOutput,
  type PsReader,
} from './macos-process-table.js'
export {
  describeError,
  type SystemProcessTable,
  type SystemProcessTableResult,
} from './system-process-table.js'
export {
  SystemInformationProcessTable,
  isInternalPowerShell,
  isInternalProcessCollector,
  parseStartedAt,
  toSystemProcessInfo,
  type SystemInformationProcessesReader,
} from './system-information-process-table.js'

/** Returns the process table for the platform, defaulting to the current one. */
export function createSystemProcessTable(
  platform: NodeJS.Platform = process.platform
): SystemProcessTable {
  return platform === 'darwin' ? new MacosProcessTable() : new SystemInformationProcessTable()
}
