import { describe, expect, test, vi } from 'vitest'
import {
  IdleTaskScheduler,
  type IdleSystemPressure,
  type IdleTaskSchedulerHost,
} from './idleTaskScheduler'

interface IdleCallback {
  callback: (deadline: { timeRemaining(): number }) => void
}

class FakeIdleHost implements IdleTaskSchedulerHost {
  nowMs = 0
  pressure: IdleSystemPressure = {
    cpuLoadRatio: 0.1,
    freeMemoryRatio: 0.8,
    userIdleSeconds: 5,
  }
  idleCallbacks: IdleCallback[] = []
  timers: Array<() => void> = []
  deferredPressureResolvers: Array<(pressure: IdleSystemPressure) => void> = []
  deferPressureProbe = false

  now(): number {
    return this.nowMs
  }

  requestIdle(callback: IdleCallback['callback']): number {
    this.idleCallbacks.push({ callback })
    return this.idleCallbacks.length
  }

  cancelIdle(): void {
    this.idleCallbacks.shift()
  }

  setTimer(callback: () => void): number {
    this.timers.push(callback)
    return this.timers.length
  }

  clearTimer(): void {
    this.timers.shift()
  }

  probeSystemPressure(): Promise<IdleSystemPressure> {
    if (!this.deferPressureProbe) return Promise.resolve(this.pressure)
    return new Promise(resolve => {
      this.deferredPressureResolvers.push(resolve)
    })
  }

  runIdle(timeRemaining = 20): void {
    const idle = this.idleCallbacks.shift()
    idle?.callback({ timeRemaining: () => timeRemaining })
  }

  runTimer(): void {
    this.timers.shift()?.()
  }

  resolveNextPressureProbe(): void {
    const resolve = this.deferredPressureResolvers.shift()
    if (!resolve) throw new Error('No deferred pressure probe is pending')
    resolve(this.pressure)
  }
}

describe('IdleTaskScheduler', () => {
  test('waits for startup and a renderer idle slice before running work', async () => {
    const host = new FakeIdleHost()
    const scheduler = new IdleTaskScheduler(host)
    const task = vi.fn()
    scheduler.schedule('maintenance', task)

    expect(host.idleCallbacks).toHaveLength(0)
    scheduler.start()
    expect(host.idleCallbacks).toHaveLength(1)

    host.nowMs = 2_000
    host.runIdle()
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce())
  })

  test('defers work after user input or when the system is under pressure', async () => {
    const host = new FakeIdleHost()
    const scheduler = new IdleTaskScheduler(host)
    const task = vi.fn()
    scheduler.start()
    scheduler.schedule('plugin-update', task)
    scheduler.recordUserActivity()

    host.runTimer()
    expect(host.idleCallbacks).toHaveLength(1)
    host.nowMs = 2_000
    host.pressure.cpuLoadRatio = 1.2
    host.runIdle()
    await vi.waitFor(() => expect(host.timers).toHaveLength(1))
    expect(task).not.toHaveBeenCalled()

    host.pressure.cpuLoadRatio = 0.2
    host.runTimer()
    host.runIdle()
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce())
  })

  test('coalesces a pending task by id and runs tasks serially', async () => {
    const host = new FakeIdleHost()
    const scheduler = new IdleTaskScheduler(host)
    host.nowMs = 2_000
    const first = vi.fn()
    const replacement = vi.fn()
    const second = vi.fn()

    scheduler.schedule('plugins', first)
    scheduler.schedule('plugins', replacement)
    scheduler.schedule('cleanup', second)
    scheduler.start()
    host.runIdle()
    await vi.waitFor(() => expect(replacement).toHaveBeenCalledOnce())
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()

    host.runIdle()
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce())
  })

  test('does not start another task while an earlier pressure probe begins running work', async () => {
    const host = new FakeIdleHost()
    const scheduler = new IdleTaskScheduler(host)
    host.nowMs = 2_000
    host.deferPressureProbe = true
    let finishFirstTask: (() => void) | undefined
    const first = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishFirstTask = resolve
        })
    )
    const second = vi.fn()

    scheduler.schedule('first', first)
    scheduler.start()
    host.runIdle()
    scheduler.schedule('second', second)
    host.runIdle()
    expect(host.deferredPressureResolvers).toHaveLength(2)

    host.resolveNextPressureProbe()
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())
    host.resolveNextPressureProbe()
    await Promise.resolve()
    expect(second).not.toHaveBeenCalled()

    finishFirstTask?.()
    await vi.waitFor(() => expect(host.idleCallbacks).toHaveLength(1))
    host.runIdle()
    host.resolveNextPressureProbe()
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce())
  })
})
