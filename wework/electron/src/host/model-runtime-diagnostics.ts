import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

type ModelRuntimeStage =
  | 'request'
  | 'transport-selection'
  | 'store'
  | 'materialize'
  | 'proxy'
  | 'vision-proxy'
  | 'proxy-settings'
  | 'system-proxy'
  | 'dispatch'
  | 'response'

export interface ModelRuntimeDiagnostic {
  requestId: string
  method: string
  stage: `${ModelRuntimeStage}:${'started' | 'completed' | 'failed'}`
  /** Per-request stage ordinal, shared by a stage's start and terminal events. */
  count: number
  durationMs: number
}

export type RecordModelRuntimeDiagnostic = (event: ModelRuntimeDiagnostic) => void | Promise<void>

/** Trace awaited native boundaries without observing model payloads or changing their outcome. */
export class ModelRuntimeTrace {
  private readonly requestId = randomUUID()
  private count = 0

  constructor(
    private readonly method: string,
    private readonly record?: RecordModelRuntimeDiagnostic
  ) {}

  async run<T>(stage: ModelRuntimeStage, operation: () => T | Promise<T>): Promise<T> {
    if (!this.record) return operation()
    const count = ++this.count
    const start = performance.now()
    const emit = (phase: 'started' | 'completed' | 'failed') => {
      try {
        // Logging is detached: a blocked or rejected sink must not gate native work.
        void Promise.resolve(
          this.record!({
            requestId: this.requestId,
            method: this.method,
            stage: `${stage}:${phase}`,
            count,
            durationMs: phase === 'started' ? 0 : Math.round(performance.now() - start),
          })
        ).catch(() => undefined)
      } catch {
        // A synchronous diagnostic failure must also leave the original operation intact.
      }
    }
    emit('started')
    try {
      const result = await operation()
      emit('completed')
      return result
    } catch (error) {
      emit('failed')
      throw error
    }
  }
}
