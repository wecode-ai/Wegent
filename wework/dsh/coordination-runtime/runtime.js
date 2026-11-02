import { planIntake } from './router.js'
import { ASSESSMENT_INSTRUCTIONS, PROJECT_ASSESSMENT_INSTRUCTIONS } from './instructions.js'

/** The plugin owns routing; all snapshots, decisions and effects remain Executor-owned. */
export class CoordinationRuntime {
  constructor(executor, { onError = () => {}, intervalMs = 5000 } = {}) {
    this.executor = executor
    this.onError = onError
    this.intervalMs = intervalMs
    this.stopped = true
    this.pending = false
    this.running = null
    this.timer = null
  }

  async start() {
    const capabilities = this.executor.describe().capabilities
    for (const capability of [
      'runtime.command-receipts-v1',
      'runtime.coordination-v1',
      'runtime.coordination-arrangements-v1',
    ]) {
      if (!capabilities.includes(capability)) {
        throw new Error(`Executor does not support ${capability}`)
      }
    }
    this.stopped = false
    // Catch-up work must not hold the desktop's plugin-startup readiness barrier.
    void this.wake()
  }

  stop() {
    this.stopped = true
    this.pending = false
    clearTimeout(this.timer)
    this.timer = null
  }

  wake() {
    if (this.stopped) return Promise.resolve()
    clearTimeout(this.timer)
    this.pending = true
    if (this.running) return this.running
    this.running = this.drain().finally(() => {
      this.running = null
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.wake(), this.intervalMs)
        this.timer.unref?.()
      }
    })
    return this.running
  }

  async drain() {
    while (this.pending && !this.stopped) {
      this.pending = false
      try {
        await this.pass()
      } catch (error) {
        this.onError(error)
      }
    }
  }

  async pass() {
    const { contexts, errors = [] } = await this.executor.request('runtime.coordination.contexts')
    for (const failure of errors) {
      this.onError(
        Object.assign(new Error(failure.message), { code: failure.code }),
        failure.contextId
      )
    }
    for (const context of contexts) {
      if (this.stopped) return
      try {
        await this.process(context)
      } catch (error) {
        // A disconnected project must not block another authorized context.
        this.onError(error, context.id)
      }
    }
  }

  async process(context) {
    if (!context.enabled || !context.needsProcessing) return
    const snapshot = await this.executor.request('runtime.coordination.snapshot', {
      contextId: context.id,
      revision: context.revision,
    })
    if (this.stopped || snapshot.skip === true) return
    if (snapshot.context.id !== context.id || snapshot.context.revision !== context.revision) {
      throw new Error('Executor returned a different coordination context')
    }
    const plan = planIntake(snapshot, {
      now: Date.parse(snapshot.now),
      force: snapshot.force === true,
    })
    if (this.stopped) return
    await this.executor.request('runtime.coordination.commit', {
      contextId: context.id,
      snapshotId: snapshot.id,
      actions: plan.actions,
      nextWakeAt: plan.nextWakeAt,
      ...(plan.actions.some(action => action.kind === 'assess')
        ? {
            assessmentInstructions:
              snapshot.context.kind === 'project'
                ? PROJECT_ASSESSMENT_INSTRUCTIONS
                : ASSESSMENT_INSTRUCTIONS,
          }
        : {}),
    })
  }

  async check(contextId) {
    await this.executor.request('runtime.coordination.wake', { contextId })
    await this.wake()
  }
}
