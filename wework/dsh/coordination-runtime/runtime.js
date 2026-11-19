import { planIntake } from './router.js'
import { ASSESSMENT_INSTRUCTIONS, PROJECT_ASSESSMENT_INSTRUCTIONS } from './instructions.js'

const MAX_COORDINATION_WORKERS = 4

/** The plugin owns routing; all snapshots, decisions and effects remain Executor-owned. */
export class CoordinationRuntime {
  constructor(executor, { onError = () => {}, intervalMs = 5000 } = {}) {
    this.executor = executor
    this.onError = onError
    this.intervalMs = intervalMs
    this.stopped = true
    this.queued = new Map()
    this.workers = new Map()
    this.discovery = null
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
    for (const job of this.queued.values()) job.resolve()
    this.queued.clear()
    clearTimeout(this.timer)
    this.timer = null
  }

  wake() {
    if (this.stopped) return Promise.resolve()
    clearTimeout(this.timer)
    if (!this.discovery) {
      this.discovery = this.pass()
        .catch(error => this.onError(error))
        .finally(() => {
          this.discovery = null
          if (!this.stopped) {
            this.timer = setTimeout(() => void this.wake(), this.intervalMs)
            this.timer.unref?.()
          }
        })
    }
    this.running = this.discovery.then(() =>
      Promise.all([...this.workers.values(), ...this.queued.values()].map(job => job.done))
    )
    return this.running
  }

  async pass() {
    const { contexts, errors = [] } = await this.executor.request('runtime.coordination.contexts')
    for (const failure of errors) {
      this.onError(
        Object.assign(new Error(failure.message), { code: failure.code }),
        failure.contextId
      )
    }
    const eligible = contexts.filter(context => context.enabled && context.needsProcessing)
    const ids = new Set(eligible.map(context => context.id))
    for (const [id, job] of this.queued) {
      if (ids.has(id)) continue
      this.queued.delete(id)
      job.resolve()
    }
    for (const context of eligible) {
      if (this.stopped) return
      if (this.workers.has(context.id)) continue
      const previous = this.queued.get(context.id)
      if (previous) {
        previous.context = context
      } else {
        let resolve
        const done = new Promise(settle => {
          resolve = settle
        })
        this.queued.set(context.id, { context, done, resolve })
      }
    }
    this.dispatch()
  }

  dispatch() {
    for (const [id, job] of this.queued) {
      if (this.stopped || this.workers.size >= MAX_COORDINATION_WORKERS) return
      this.queued.delete(id)
      this.workers.set(id, job)
      void this.process(job.context)
        .catch(error => this.onError(error, id))
        .finally(() => {
          this.workers.delete(id)
          job.resolve()
          this.dispatch()
        })
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
    void this.wake()
    await this.discovery
    await (this.workers.get(contextId) ?? this.queued.get(contextId))?.done
  }
}
