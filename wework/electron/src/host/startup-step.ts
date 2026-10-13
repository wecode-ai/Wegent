import type { ProcessMetric, WebContents } from 'electron'
import { startupExceptionKind } from './startup-exception-monitor.js'

export function rendererStartupCpuDetails(
  enabled: boolean,
  contents: Pick<WebContents, 'isDestroyed' | 'getOSProcessId'> | null,
  getMetrics: () => Pick<ProcessMetric, 'pid' | 'cpu'>[]
): Record<string, number | boolean> {
  if (!enabled) return {}
  try {
    if (!contents || contents.isDestroyed()) return { rendererCpuAvailable: false }
    const pid = contents.getOSProcessId()
    if (!Number.isSafeInteger(pid) || pid <= 0) return { rendererCpuAvailable: false }
    const seconds = getMetrics().find(metric => metric.pid === pid)?.cpu.cumulativeCPUUsage
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
      const milliseconds = Math.round(seconds * 1000)
      if (Number.isFinite(milliseconds)) {
        return {
          rendererCpuAvailable: true,
          rendererCpuProcessId: pid,
          rendererCpuMs: milliseconds,
        }
      }
    }
  } catch {
    // A renderer can exit between the lifecycle event and the metrics snapshot.
  }
  return { rendererCpuAvailable: false }
}

export function logStartupStep(
  step: string,
  status: 'started' | 'completed' | 'failed',
  details: Record<string, unknown> = {}
): void {
  const usage = process.resourceUsage()
  console.info('[startup]', {
    step,
    status,
    elapsedMs: Math.round(performance.now()),
    userCpuMs: Math.round(usage.userCPUTime / 1000),
    systemCpuMs: Math.round(usage.systemCPUTime / 1000),
    voluntaryContextSwitches: usage.voluntaryContextSwitches,
    involuntaryContextSwitches: usage.involuntaryContextSwitches,
    ...details,
  })
}

export function runSynchronousStartupStep<Result>(step: string, operation: () => Result): Result {
  logStartupStep(step, 'started')
  try {
    const result = operation()
    logStartupStep(step, 'completed')
    return result
  } catch (error) {
    logStartupStep(step, 'failed', { errorKind: startupExceptionKind(error) })
    throw error
  }
}
