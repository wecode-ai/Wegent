import { powerSaveBlocker } from 'electron'

export class SystemSleepController {
  private readonly activeSources = new Set<string>()
  private blockerId: number | null = null
  private enabled = true

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.reconcile()
  }

  setTaskActive(source: string, active: boolean): void {
    if (active) this.activeSources.add(source)
    else this.activeSources.delete(source)
    console.log(
      `System sleep task activity: source=${source} active=${active} active_sources=${[
        ...this.activeSources,
      ].join(',')}`
    )
    this.reconcile()
  }

  stop(): void {
    this.activeSources.clear()
    this.reconcile()
  }

  handleExecutorEvent(event: string, payload: Record<string, unknown>): void {
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : null
    if (event.startsWith('response.')) {
      console.log(`Executor sleep event: event=${event} task_id=${taskId ?? 'missing'}`)
    }
    if (!taskId) return
    const source = `executor:${taskId}`
    if (event === 'response.created') {
      this.setTaskActive(source, true)
      return
    }
    if (
      event === 'response.completed' ||
      event === 'response.failed' ||
      event === 'response.incomplete'
    ) {
      this.setTaskActive(source, false)
    }
  }

  private reconcile(): void {
    if (this.enabled && this.activeSources.size > 0) {
      if (this.blockerId === null || !powerSaveBlocker.isStarted(this.blockerId)) {
        this.blockerId = powerSaveBlocker.start('prevent-app-suspension')
        console.log('Inhibited system sleep while local tasks are running')
      }
      return
    }
    if (this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)) {
      powerSaveBlocker.stop(this.blockerId)
      console.log('Released system sleep inhibition after local tasks settled')
    }
    this.blockerId = null
  }
}
