import assert from 'node:assert/strict'
import { TransportFaultProxy } from './transport-fault-proxy.mjs'

/** Fault real Backend transport without fabricating API responses or catalog state. */
export class BackendFaultGate {
  constructor(target, path, blocked = false) {
    this.path = path
    this.faults = new Map(blocked ? [[path, 'hold']] : [])
    this.failures = 0
    this.blockedWaiters = new Set()
    this.failureWaiters = new Set()
    this.proxy = new TransportFaultProxy(target)
    this.proxy.rule = entry => {
      const mode = this.faults.get(entry.path)
      if (!mode) return null
      if (mode === 'hold') {
        for (const waiter of this.blockedWaiters) waiter.resolve(entry)
        this.blockedWaiters.clear()
        return 'pause-request'
      }
      if (entry.path === this.path) this.recordFailure()
      return 'disconnect'
    }
  }

  async start() {
    await this.proxy.start()
    return this
  }

  get url() {
    return this.proxy.url
  }

  awaitBlocked(path) {
    assert.equal(path, this.path, 'The Backend gate does not cover this API')
    const existing = this.proxy.requests.find(
      entry => entry.path === path && entry.fault === 'pause-request'
    )
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => this.blockedWaiters.add({ resolve, reject }))
  }

  recordFailure() {
    this.failures += 1
    for (const waiter of this.failureWaiters) waiter.resolve()
    this.failureWaiters.clear()
  }

  fail() {
    this.setFault(this.path, 'fail')
  }

  setFault(path, mode) {
    assert.ok(['hold', 'fail', 'live'].includes(mode), 'Unknown Backend transport fault')
    if (mode === 'live') this.faults.delete(path)
    else this.faults.set(path, mode)
    for (const entry of [...this.proxy.pausedRequests]) {
      if (entry.path !== path) continue
      if (mode === 'fail' && entry.cancel() && path === this.path) this.recordFailure()
      if (mode === 'live') entry.release()
    }
  }

  restore() {
    this.setFault(this.path, 'live')
  }

  awaitFailure() {
    if (this.failures > 0) return Promise.resolve()
    return new Promise((resolve, reject) => this.failureWaiters.add({ resolve, reject }))
  }

  async stop() {
    for (const waiter of [...this.blockedWaiters, ...this.failureWaiters]) {
      waiter.reject(new Error('Backend fault gate stopped'))
    }
    this.blockedWaiters.clear()
    this.failureWaiters.clear()
    await this.proxy.stop()
  }
}
