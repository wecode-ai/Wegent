export interface StartupStageEvent {
  stage: string
  phase: 'started' | 'completed' | 'failed'
  elapsedMs: number
  details?: Record<string, unknown>
}

export type StartupStageReporter = (event: StartupStageEvent) => void

export async function runStartupStage<Result>(
  report: StartupStageReporter | undefined,
  stage: string,
  run: () => Promise<Result>,
  details?: (result: Result) => Record<string, unknown>
): Promise<Result> {
  const startedAt = performance.now()
  const emit = (phase: StartupStageEvent['phase'], eventDetails?: Record<string, unknown>) => {
    try {
      report?.({
        stage,
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...(eventDetails ? { details: eventDetails } : {}),
      })
    } catch {
      // Diagnostics must never interrupt startup preparation.
    }
  }
  emit('started')
  try {
    const result = await run()
    let resultDetails: Record<string, unknown> | undefined
    try {
      resultDetails = details?.(result)
    } catch {
      // Diagnostics must never turn a completed startup stage into a failure.
    }
    emit('completed', resultDetails)
    return result
  } catch (error) {
    emit('failed')
    throw error
  }
}
