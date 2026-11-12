import {
  acquireDebuggerSession,
  type DebuggerLease,
  type DebuggerTarget,
} from './debugger-session.js'

export interface BrowserDeviceMetrics {
  width: number
  height: number
  scale: number
}

export class BrowserDeviceMetricsController {
  private lease: DebuggerLease | null = null
  private pending: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly target: DebuggerTarget) {}

  set(metrics: BrowserDeviceMetrics | null): Promise<void> {
    if (metrics && (!Number.isFinite(metrics.scale) || metrics.scale <= 0 || metrics.scale > 5)) {
      return Promise.reject(new Error('Browser device scale is invalid'))
    }
    const update = this.pending.then(() => this.apply(metrics))
    this.pending = update.catch(() => {})
    return update
  }

  dispose(): void {
    this.disposed = true
    this.lease?.release()
    this.lease = null
  }

  private async apply(metrics: BrowserDeviceMetrics | null): Promise<void> {
    if (this.disposed) throw new Error('Embedded browser was closed before updating device metrics')
    if (!this.lease?.isActive()) {
      this.lease?.release()
      this.lease = null
    }
    if (!metrics) {
      const lease = this.lease
      if (!lease) return
      try {
        await lease.session.sendCommand('Emulation.clearDeviceMetricsOverride')
      } finally {
        lease.release()
        if (this.lease === lease) this.lease = null
      }
      return
    }
    const hadOverride = this.lease !== null
    const lease = (this.lease ??= acquireDebuggerSession(this.target))
    try {
      await lease.session.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: Math.max(1, Math.round(metrics.width)),
        height: Math.max(1, Math.round(metrics.height)),
        deviceScaleFactor: 1,
        mobile: false,
        scale: metrics.scale,
      })
    } catch (error) {
      if (!hadOverride) {
        lease.release()
        if (this.lease === lease) this.lease = null
      }
      throw error
    }
  }
}
