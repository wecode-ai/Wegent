// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskRecoveryReason } from './TaskStateMachine.types'

export class RuntimeStabilityProbe {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null
  private running: boolean = false
  private generation: number = 0
  private reason?: TaskRecoveryReason
  private readonly runCheck: (reason: TaskRecoveryReason) => Promise<void>
  private readonly resync: () => void
  private readonly isClosed: () => boolean

  constructor(
    runCheck: (reason: TaskRecoveryReason) => Promise<void>,
    resync: () => void,
    isClosed: () => boolean
  ) {
    this.runCheck = runCheck
    this.resync = resync
    this.isClosed = isClosed
  }

  schedule(reason: TaskRecoveryReason, delayMs: number): void {
    if (this.reason === reason && (this.timer !== null || this.running)) {
      return
    }

    this.stop()
    this.reason = reason
    const generation = ++this.generation
    const timer = globalThis.setTimeout(() => {
      this.timer = null
      void this.run(generation, reason)
    }, delayMs)
    const nodeTimer = timer as unknown as { unref?: () => void }
    if (typeof nodeTimer.unref === 'function') {
      nodeTimer.unref()
    }
    this.timer = timer
  }

  async runNow(reason: TaskRecoveryReason): Promise<void> {
    this.stop()
    const generation = ++this.generation
    await this.run(generation, reason)
  }

  stop(): void {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer)
    }
    this.timer = null
    this.reason = undefined
    this.generation += 1
  }

  private async run(generation: number, reason: TaskRecoveryReason): Promise<void> {
    if (this.isClosed() || generation !== this.generation || this.running) {
      return
    }

    this.running = true
    try {
      await this.runCheck(reason)
    } catch {
      // Keep the unstable state. The state machine will re-arm the probe if it is still needed.
    } finally {
      this.running = false
      this.resync()
    }
  }
}
