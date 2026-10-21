import { app, webContents } from 'electron'
import type { HostProcessDescriptor } from '../vendor/process-explorer/contract.js'
import {
  createElectronMetricsSource,
  createSystemProcessTable,
  ProcessExplorerService,
  readRendererProcesses,
} from '../vendor/process-explorer/host/index.js'

export interface WeworkWorkbenchRuntime {
  tabId: string
  pid: number | null
}

export interface WeworkProcessExplorerRuntime {
  coreDshPid: number | null
  executorPid: number | null
  workbenchRuntimes: readonly WeworkWorkbenchRuntime[]
  pluginDevelopmentPids: readonly number[]
}

export interface WeworkProcessExplorerOptions {
  /** Resolves a registered DSH window label for diagnostics. */
  windowLabel: (webContentsId: number) => string | null
  /** Resolves an embedded browser label for diagnostics. */
  embeddedBrowserLabel?: (webContentsId: number) => string | null
  runtime: () => WeworkProcessExplorerRuntime | Promise<WeworkProcessExplorerRuntime>
}

/**
 * Wework's assembly of the reusable process explorer: it supplies Electron
 * metrics, the platform process table, renderer labels, and the runtime pids
 * the host already knows about.
 */
export function createWeworkProcessExplorerService(
  options: WeworkProcessExplorerOptions
): ProcessExplorerService {
  const metrics = createElectronMetricsSource({
    applicationPid: process.pid,
    metrics: app,
    windows: () =>
      readRendererProcesses(webContents.getAllWebContents(), contents => {
        const embeddedLabel = options.embeddedBrowserLabel?.(contents.id)
        if (embeddedLabel) return `Browser: ${embeddedLabel}`
        const windowLabel = options.windowLabel(contents.id)
        if (windowLabel === 'main') return contents.getTitle().trim() || 'Workbench'
        return contents.getTitle().trim() || windowLabel || ''
      }),
  })

  return new ProcessExplorerService({
    applicationPid: metrics.applicationPid,
    applicationName: app.getName(),
    metrics: metrics.metrics,
    windows: metrics.windows,
    systemTable: createSystemProcessTable(),
    hostProcesses: async () => {
      const runtime = await options.runtime()
      const descriptors: HostProcessDescriptor[] = []
      if (runtime.coreDshPid) {
        descriptors.push({
          pid: runtime.coreDshPid,
          name: 'Core runtime',
          kind: 'host-service',
          identity: 'core-runtime',
          owner: { id: 'core-runtime', label: 'Core runtime', key: 'core-runtime' },
          includeDescendants: true,
        })
      }
      if (runtime.executorPid) {
        descriptors.push({
          pid: runtime.executorPid,
          name: 'Executor',
          kind: 'host-service',
          identity: 'executor',
          owner: { id: 'executor', label: 'Executor', key: 'executor' },
          includeDescendants: true,
        })
      }
      for (const workbench of runtime.workbenchRuntimes) {
        if (!workbench.pid) continue
        descriptors.push({
          pid: workbench.pid,
          name: `Workbench: ${workbench.tabId}`,
          kind: 'host-service',
          identity: workbench.tabId,
          owner: {
            id: `workbench:${workbench.tabId}`,
            label: `Workbench: ${workbench.tabId}`,
          },
          includeDescendants: true,
        })
      }
      for (const pid of runtime.pluginDevelopmentPids) {
        descriptors.push({
          pid,
          name: 'Plugin development',
          kind: 'host-service',
          identity: 'plugin-development',
          owner: {
            id: 'plugin-development',
            label: 'Plugin development',
            key: 'plugin-development',
          },
          includeDescendants: true,
        })
      }
      return descriptors
    },
  })
}
