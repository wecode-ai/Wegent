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
import { startupExceptionKind } from './startup-exception-monitor.js'

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
