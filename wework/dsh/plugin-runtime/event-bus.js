/** Providers plan queries. Subscribers own delivery and consumer state. */
export class EventBus {
  #providers = new Map()
  #subscribers = new Set()
  #active = new Map()
  #scheduled = false
  #timer = null
  #stopped = false

  constructor({ workers = 8, timeoutMs = 15_000, intervalMs = 15_000 } = {}) {
    this.workers = workers
    this.timeoutMs = timeoutMs
    this.intervalMs = intervalMs
  }

  registerProvider(id, provider) {
    if (this.#providers.has(id)) throw new Error(`Duplicate event provider ${id}`)
    this.#providers.set(id, provider)
    return () => {
      this.#providers.delete(id)
      for (const entry of this.#subscribers)
        if (entry.providerId === id) {
          this.#report(entry, new Error(`Event provider stopped: ${id}`))
          this.#remove(entry)
        }
    }
  }

  subscribe(
    providerId,
    query,
    { onResult, onError, signal, once = false, intervalMs = this.intervalMs }
  ) {
    if (this.#stopped || !this.#providers.has(providerId)) {
      throw new Error(`Event provider unavailable: ${providerId}`)
    }
    signal?.throwIfAborted()
    const entry = { providerId, query, onResult, onError, signal, once, intervalMs, due: 0 }
    entry.dispose = () => this.#remove(entry)
    signal?.addEventListener('abort', entry.dispose, { once: true })
    this.#subscribers.add(entry)
    this.#schedule()
    return entry.dispose
  }

  request(providerId, query, signal) {
    let abort
    return new Promise((resolve, reject) => {
      this.subscribe(providerId, query, {
        once: true,
        signal,
        onResult: resolve,
        onError: reject,
      })
      abort = () => reject(signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
    }).finally(() => signal?.removeEventListener('abort', abort))
  }

  stop() {
    this.#stopped = true
    clearTimeout(this.#timer)
    for (const job of this.#active.values()) job.controller.abort()
    for (const entry of this.#subscribers) {
      if (entry.once) this.#report(entry, new Error('Event bus stopped'))
      this.#remove(entry)
    }
  }

  #remove(entry) {
    this.#subscribers.delete(entry)
    entry.signal?.removeEventListener('abort', entry.dispose)
    if (entry.job && [...entry.job.entries].every(item => !this.#subscribers.has(item))) {
      entry.job.controller.abort()
    }
  }

  #schedule() {
    if (this.#stopped || this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      if (!this.#stopped) this.#poll()
    })
  }

  #poll() {
    clearTimeout(this.#timer)
    const now = Date.now()
    let next = Infinity
    const due = new Map()
    for (const entry of this.#subscribers) {
      if (entry.job) continue
      if (entry.due > now) {
        next = Math.min(next, entry.due)
      } else {
        const entries = due.get(entry.providerId) ?? []
        entries.push(entry)
        due.set(entry.providerId, entries)
      }
    }
    for (const [id, entries] of due) {
      const provider = this.#providers.get(id)
      let plan
      try {
        plan = [...provider.plan(entries)]
      } catch (error) {
        for (const entry of entries) {
          this.#report(entry, error)
          this.#finish(entry)
        }
        next = Math.min(next, ...entries.filter(entry => !entry.once).map(entry => entry.due))
        continue
      }
      for (const group of plan) {
        const key = JSON.stringify([id, group.key])
        const active = this.#active.get(key)
        if (active) {
          // An identical admitted query may already be in flight.
          if (!active.controller.signal.aborted)
            for (const entry of group.entries) this.#attach(entry, active)
          continue
        }
        if (this.#active.size >= this.workers) continue
        const job = { controller: new AbortController(), entries: new Set() }
        this.#active.set(key, job)
        for (const entry of group.entries) this.#attach(entry, job)
        void this.#collect(provider, key, group.query, job)
      }
    }
    if (Number.isFinite(next)) {
      this.#timer = setTimeout(() => this.#schedule(), Math.max(0, next - Date.now()))
      this.#timer.unref?.()
    }
  }

  #attach(entry, job) {
    entry.job = job
    job.entries.add(entry)
  }

  #report(entry, error) {
    void Promise.resolve()
      .then(() => entry.onError?.(error))
      .catch(() => {})
  }

  #finish(entry) {
    delete entry.job
    entry.due = Date.now() + entry.intervalMs
    if (entry.once) this.#remove(entry)
  }

  async #collect(provider, key, query, job) {
    const timeout = setTimeout(() => {
      job.controller.abort(
        Object.assign(new Error('Event provider timed out'), {
          code: 'request_timeout',
          retryAfterMs: 30_000,
        })
      )
    }, this.timeoutMs)
    timeout.unref?.()
    const { signal } = job.controller
    const aborted = new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    try {
      const result = await Promise.race([provider.poll(query, signal), aborted])
      for (const entry of job.entries) {
        if (!this.#subscribers.has(entry)) continue
        try {
          const selected = provider.select(result, entry.query)
          void Promise.resolve(entry.onResult(selected)).catch(error => this.#report(entry, error))
        } catch (error) {
          this.#report(entry, error)
        }
      }
    } catch (error) {
      for (const entry of job.entries) {
        if (this.#subscribers.has(entry)) this.#report(entry, error)
      }
    } finally {
      clearTimeout(timeout)
      this.#active.delete(key)
      for (const entry of job.entries) this.#finish(entry)
      this.#schedule()
    }
  }
}
