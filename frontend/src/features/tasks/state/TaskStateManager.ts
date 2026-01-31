// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TaskStateManager
 *
 * Singleton manager for TaskStateMachine instances.
 * Provides global access to task state machines and coordinates
 * recovery across all active tasks.
 */

import {
  TaskStateMachine,
  TaskStateMachineDeps,
  SyncOptions,
  TaskStateData,
} from './TaskStateMachine'

/**
 * TaskStateManager - singleton manager for all TaskStateMachine instances
 */
class TaskStateManagerImpl {
  private machines: Map<number, TaskStateMachine> = new Map()
  private deps: TaskStateMachineDeps | null = null
  private globalListeners: Set<(taskId: number, state: TaskStateData) => void> = new Set()

  /**
   * Initialize the manager with dependencies from SocketContext
   * This MUST be called before using any other methods
   */
  initialize(deps: TaskStateMachineDeps): void {
    this.deps = deps
    console.log('[TaskStateManager] Initialized with dependencies')
  }

  /**
   * Check if manager is initialized
   */
  isInitialized(): boolean {
    return this.deps !== null
  }

  /**
   * Get or create a TaskStateMachine for a task
   */
  getOrCreate(taskId: number): TaskStateMachine {
    if (!this.deps) {
      throw new Error('[TaskStateManager] Not initialized. Call initialize() first.')
    }

    let machine = this.machines.get(taskId)
    if (!machine) {
      machine = new TaskStateMachine(taskId, this.deps)
      this.machines.set(taskId, machine)

      // Subscribe to state changes and notify global listeners
      machine.subscribe(state => {
        this.notifyGlobalListeners(taskId, state)
      })

      console.log('[TaskStateManager] Created new TaskStateMachine for task', taskId)
    }
    return machine
  }

  /**
   * Get an existing TaskStateMachine (returns undefined if not exists)
   */
  get(taskId: number): TaskStateMachine | undefined {
    return this.machines.get(taskId)
  }

  /**
   * Recover all active tasks
   * Called after WebSocket reconnection
   */
  async recoverAll(): Promise<void> {
    console.log('[TaskStateManager] Starting recovery for all tasks')

    const recoveryPromises: Promise<void>[] = []
    for (const [taskId, machine] of this.machines) {
      console.log('[TaskStateManager] Recovering task', taskId)
      recoveryPromises.push(machine.recover({ force: true }))
    }

    await Promise.allSettled(recoveryPromises)
    console.log('[TaskStateManager] All task recoveries initiated')
  }

  /**
   * Clean up a TaskStateMachine for a task
   */
  cleanup(taskId: number): void {
    const machine = this.machines.get(taskId)
    if (machine) {
      machine.leave()
      this.machines.delete(taskId)
      console.log('[TaskStateManager] Cleaned up TaskStateMachine for task', taskId)
    }
  }

  /**
   * Clean up all TaskStateMachines
   */
  cleanupAll(): void {
    for (const [taskId, machine] of this.machines) {
      machine.leave()
      console.log('[TaskStateManager] Cleaned up TaskStateMachine for task', taskId)
    }
    this.machines.clear()
  }

  /**
   * Get all active task IDs
   */
  getActiveTaskIds(): number[] {
    return Array.from(this.machines.keys())
  }

  /**
   * Get all streaming task IDs
   */
  getStreamingTaskIds(): number[] {
    const streamingIds: number[] = []
    for (const [taskId, machine] of this.machines) {
      const state = machine.getState()
      if (state.status === 'streaming') {
        streamingIds.push(taskId)
      }
    }
    return streamingIds
  }

  /**
   * Set sync options for a task
   */
  setSyncOptions(taskId: number, options: SyncOptions): void {
    const machine = this.get(taskId)
    if (machine) {
      machine.setSyncOptions(options)
    }
  }

  /**
   * Subscribe to global state changes (all tasks)
   */
  subscribeGlobal(listener: (taskId: number, state: TaskStateData) => void): () => void {
    this.globalListeners.add(listener)
    return () => {
      this.globalListeners.delete(listener)
    }
  }

  /**
   * Notify all global listeners
   */
  private notifyGlobalListeners(taskId: number, state: TaskStateData): void {
    this.globalListeners.forEach(listener => {
      try {
        listener(taskId, state)
      } catch (err) {
        console.error('[TaskStateManager] Error in global listener:', err)
      }
    })
  }
}

// Export singleton instance
export const taskStateManager = new TaskStateManagerImpl()

// Export class type for testing
export type { TaskStateManagerImpl }
