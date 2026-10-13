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
