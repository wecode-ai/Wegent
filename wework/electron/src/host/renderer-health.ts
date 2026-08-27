import { EventEmitter } from 'node:events'

export type RendererHealthState =
  | 'loading'
  | 'ready'
  | 'unresponsive'
  | 'crashed'
  | 'recreating'
  | 'failed'

export interface RendererHealthSnapshot {
  state: RendererHealthState
  generation: number
  crashCount: number
  reason: string | null
  updatedAt: string
}

export interface RendererHealthOptions {
  crashWindowMs?: number
  maxAutomaticRecreations?: number
  now?: () => number
}

export class RendererHealthService extends EventEmitter<{
  change: [RendererHealthSnapshot]
}> {
  private readonly crashWindowMs: number
  private readonly maxAutomaticRecreations: number
  private readonly now: () => number
  private crashTimestamps: number[] = []
  private current: RendererHealthSnapshot

  constructor(options: RendererHealthOptions = {}) {
    super()
    this.crashWindowMs = options.crashWindowMs ?? 60_000
    this.maxAutomaticRecreations = options.maxAutomaticRecreations ?? 3
    this.now = options.now ?? Date.now
    this.current = this.createSnapshot('loading', 0, null)
  }

  snapshot(): RendererHealthSnapshot {
    return { ...this.current }
  }

  loading(): void {
    this.transition('loading', this.current.generation + 1, null)
  }

  ready(): void {
    this.transition('ready', this.current.generation, null)
  }

  unresponsive(): void {
    if (this.current.state !== 'ready') return
    this.transition('unresponsive', this.current.generation, 'renderer_unresponsive')
  }

  responsive(): void {
    if (this.current.state !== 'unresponsive') return
    this.transition('ready', this.current.generation, null)
  }

  crashed(reason: string): boolean {
    const now = this.now()
    this.crashTimestamps = this.crashTimestamps.filter(
      timestamp => now - timestamp <= this.crashWindowMs
    )
    this.crashTimestamps.push(now)
    this.transition('crashed', this.current.generation, reason)
    if (this.crashTimestamps.length > this.maxAutomaticRecreations) {
      this.transition('failed', this.current.generation, 'renderer_crash_limit')
      return false
    }
    return true
  }

  recreating(): void {
    if (this.current.state === 'failed') return
    this.transition('recreating', this.current.generation, this.current.reason)
  }

  failed(reason: string): void {
    this.transition('failed', this.current.generation, reason)
  }

  private transition(state: RendererHealthState, generation: number, reason: string | null): void {
    this.current = this.createSnapshot(state, generation, reason)
    this.emit('change', this.snapshot())
  }

  private createSnapshot(
    state: RendererHealthState,
    generation: number,
    reason: string | null
  ): RendererHealthSnapshot {
    return {
      state,
      generation,
      crashCount: this.crashTimestamps.length,
      reason,
      updatedAt: new Date(this.now()).toISOString(),
    }
  }
}
