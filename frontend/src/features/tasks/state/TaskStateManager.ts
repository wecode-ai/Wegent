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

    const existing = this.machines.get(taskId)
    if (existing) return existing

    const machine = new TaskStateMachine(taskId, this.deps)
    this.machines.set(taskId, machine)

    // Subscribe to state changes and notify global listeners
    machine.subscribe(state => {
      this.notifyGlobalListeners(taskId, state)
    })

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
   *
   * Note: Uses Set to dedupe by machine instance since migrateState()
   * keeps both temp and real task IDs pointing to the same machine.
   */
  async recoverAll(): Promise<void> {
    // Dedupe by machine instance to avoid recovering the same machine twice
    // This is needed because migrateState() keeps both temp and real IDs
    const uniqueMachines = new Set(this.machines.values())
    const recoveryPromises: Promise<void>[] = []

    for (const machine of uniqueMachines) {
      recoveryPromises.push(machine.recover({ force: true }))
    }

    await Promise.allSettled(recoveryPromises)
  }

  /**
   * Clean up a TaskStateMachine for a task
   */
  cleanup(taskId: number): void {
    const machine = this.machines.get(taskId)
    if (machine) {
      machine.leave()
      this.machines.delete(taskId)
    }
  }

  /**
   * Clean up all TaskStateMachines
   */
  cleanupAll(): void {
    for (const [_, machine] of this.machines) {
      machine.leave()
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
   * Migrate state from a temporary task ID to a real task ID.
   * This is needed when a new task is created - the UI uses a negative temp ID
   * until the server returns the real task ID.
   *
   * IMPORTANT: This method makes BOTH the temp and real task IDs point to the
   * SAME state machine instance. This ensures:
   * - All WebSocket events (chat:start, chat:done, etc.) work with either ID
   * - Components using either ID will get the same state machine
   * - No state copying is needed - both IDs reference the same machine
   * - The streaming state is preserved automatically
   *
   * The temp ID mapping is kept so that components still using the temp ID
   * (e.g., useTaskStateMachine with pendingTaskId) will continue to work.
   *
   * @param tempTaskId - The temporary (negative) task ID
   * @param realTaskId - The real (positive) task ID from server
   */
  migrateState(tempTaskId: number, realTaskId: number): void {
    const tempMachine = this.machines.get(tempTaskId)
    if (!tempMachine) {
      return
    }

    // Check if real machine already exists (shouldn't happen normally)
    const existingRealMachine = this.machines.get(realTaskId)
    if (existingRealMachine && existingRealMachine !== tempMachine) {
      console.warn('[TaskStateManager] Real machine already exists, cleaning up temp machine', {
        tempTaskId,
        realTaskId,
      })
      // Clean up temp machine, keep real machine
      tempMachine.leave()
      this.machines.delete(tempTaskId)
      return
    }

    // Make real task ID point to the same state machine instance
    // IMPORTANT: Keep BOTH mappings so components using either ID work correctly
    // This is the key: both IDs now reference the SAME machine
    this.machines.set(realTaskId, tempMachine)
    // DO NOT delete tempTaskId mapping - components may still be using it
    // this.machines.delete(tempTaskId)  // REMOVED - keep both mappings
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
