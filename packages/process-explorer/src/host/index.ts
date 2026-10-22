import { SystemInformationProcessTable } from './system-information-process-table.js'
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

/** Returns the cross-platform process table. */
export function createSystemProcessTable(): SystemProcessTable {
  return new SystemInformationProcessTable()
}
