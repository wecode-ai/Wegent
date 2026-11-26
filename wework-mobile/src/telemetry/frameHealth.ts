import type { MobileAnalyticsEventMap } from './events'

export type FrameHealthWindow = MobileAnalyticsEventMap['mobile_frame_health']

const FRAME_BUDGET_MS = 1000 / 60
const JANK_GAP_MS = 100
const LONG_STALL_GAP_MS = 500
const REPORT_INTERVAL_MS = 60_000

export class FrameHealthSampler {
  private startedAt: number | null = null
  private lastFrameAt: number | null = null
  private totalFrames = 0
  private renderedFrames = 0
  private jankFrames = 0
  private maxStallMs = 0
  private stallsOver100Ms = 0
  private stallsOver500Ms = 0

  record(timestamp: number): FrameHealthWindow | null {
    if (this.startedAt === null) {
      this.startedAt = timestamp
      this.lastFrameAt = timestamp
      this.renderedFrames = 1
      this.totalFrames = 1
      return null
    }
    if (this.lastFrameAt === null) return null
    const elapsed = Math.max(0, timestamp - this.lastFrameAt)
    this.lastFrameAt = timestamp
    this.renderedFrames += 1
    this.totalFrames += 1
    if (elapsed > FRAME_BUDGET_MS * 1.5) {
      const missed = Math.max(0, Math.round(elapsed / FRAME_BUDGET_MS) - 1)
      this.jankFrames += missed
      this.totalFrames += missed
    }
    if (elapsed >= JANK_GAP_MS) {
      this.stallsOver100Ms += 1
      this.maxStallMs = Math.max(this.maxStallMs, elapsed)
    }
    if (elapsed >= LONG_STALL_GAP_MS) this.stallsOver500Ms += 1
    if (timestamp - this.startedAt < REPORT_INTERVAL_MS) return null
    return this.flush(timestamp)
  }

  flush(timestamp: number): FrameHealthWindow | null {
    if (this.startedAt === null || this.renderedFrames < 2) {
      this.reset()
      return null
    }
    const durationMs = Math.max(1, timestamp - this.startedAt)
    const totalFrames = Math.max(this.renderedFrames, this.totalFrames)
    const result: FrameHealthWindow = {
      duration_ms: Math.round(durationMs),
      total_frames: totalFrames,
      rendered_frames: this.renderedFrames,
      jank_frames: this.jankFrames,
      jank_rate: Math.min(1, this.jankFrames / totalFrames),
      max_stall_ms: Math.round(this.maxStallMs),
      stalls_over_100ms: this.stallsOver100Ms,
      stalls_over_500ms: this.stallsOver500Ms,
    }
    this.reset()
    return result
  }

  reset(): void {
    this.startedAt = null
    this.lastFrameAt = null
    this.totalFrames = 0
    this.renderedFrames = 0
    this.jankFrames = 0
    this.maxStallMs = 0
    this.stallsOver100Ms = 0
    this.stallsOver500Ms = 0
  }
}
