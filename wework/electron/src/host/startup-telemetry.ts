export type StartupFailureStage =
  | 'core_plugin'
  | 'desktop_runtime'
  | 'renderer_initialize'
  | 'renderer_load'
  | 'unknown'

interface StartupTelemetryDependencies {
  readonly id: string
  readonly now: () => number
  readonly publish: (type: string, payload: Record<string, unknown>) => void
}

export class StartupTelemetryLifecycle {
  private readonly startedAt: number
  private settled = false

  constructor(private readonly dependencies: StartupTelemetryDependencies) {
    this.startedAt = dependencies.now()
  }

  start(): void {
    this.dependencies.publish('startup.attempted', {
      startup_id: this.dependencies.id,
    })
  }

  succeed(): boolean {
    return this.settle('startup.succeeded')
  }

  fail(failureStage: StartupFailureStage): boolean {
    return this.settle('startup.failed', { failure_stage: failureStage })
  }

  private settle(type: string, payload: Record<string, unknown> = {}): boolean {
    if (this.settled) return false
    this.settled = true
    this.dependencies.publish(type, {
      startup_id: this.dependencies.id,
      duration_ms: Math.max(0, Math.round(this.dependencies.now() - this.startedAt)),
      ...payload,
    })
    return true
  }
}
