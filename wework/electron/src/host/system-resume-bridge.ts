interface SystemResumeSource {
  on(event: 'resume', listener: () => void): void
  off(event: 'resume', listener: () => void): void
}

interface SystemResumeTarget {
  isDestroyed(): boolean
  send(channel: string): void
}

export class SystemResumeBridge {
  private started = false
  private readonly handleResume = () => {
    for (const target of this.listTargets()) {
      if (!target.isDestroyed()) target.send('system:resume')
    }
  }

  constructor(
    private readonly source: SystemResumeSource,
    private readonly listTargets: () => SystemResumeTarget[]
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.source.on('resume', this.handleResume)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.source.off('resume', this.handleResume)
  }
}
