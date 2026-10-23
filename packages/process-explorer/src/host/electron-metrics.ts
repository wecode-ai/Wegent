import type { ElectronProcessMetric, WindowProcessInfo } from '../core/build-snapshot.js'

/**
 * Structural shape of `app.getAppMetrics()`. The package does not import
 * Electron at runtime or at type level, so an embedding host passes its own
 * `app` object and remains free to test with plain values.
 */
export interface ElectronMetricsReader {
  getAppMetrics: () => readonly ElectronProcessMetric[]
}

export interface ElectronMetricsHost {
  applicationPid: number
  metrics: ElectronMetricsReader
  windows?: () => readonly WindowProcessInfo[]
}

export interface ElectronMetricsSource {
  applicationPid: number
  metrics: () => readonly ElectronProcessMetric[]
  windows: () => readonly WindowProcessInfo[]
}

export function createElectronMetricsSource(host: ElectronMetricsHost): ElectronMetricsSource {
  return {
    applicationPid: host.applicationPid,
    metrics: () => host.metrics.getAppMetrics(),
    windows: () => host.windows?.() ?? [],
  }
}

export interface RendererContentsLike {
  id: number
  getOSProcessId: () => number
  getTitle: () => string
}

/**
 * Maps renderer pids to labels. Pass every live `webContents`, not only
 * `BrowserWindow` contents, so embedded browser views are labelled too. A
 * renderer can host more than one WebContents, so the first label wins.
 */
export function readRendererProcesses(
  contents: readonly RendererContentsLike[],
  labelFor?: (contents: RendererContentsLike, index: number) => string
): WindowProcessInfo[] {
  const byPid = new Map<number, string>()
  contents.forEach((entry, index) => {
    const pid = entry.getOSProcessId()
    if (!Number.isSafeInteger(pid) || pid <= 0 || byPid.has(pid)) return
    const label = labelFor?.(entry, index)
    byPid.set(pid, label || entry.getTitle().trim() || 'Window')
  })
  return [...byPid].map(([pid, label]) => ({ pid, label }))
}
