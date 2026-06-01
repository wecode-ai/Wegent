// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * TaskStateManager
 *
 * Singleton manager for TaskStateMachine instances.
 * Provides global access to task state machines.
 */

import type { TaskDetail, TaskStatus as ApiTaskStatus } from '@/types/api'
import {
  TaskStateMachine,
  TaskStateMachineDeps,
  SyncOptions,
  TaskStateData,
  TaskRecoveryReason,
} from './TaskStateMachine'

/**
 * TaskStateManager - singleton manager for all TaskStateMachine instances
 */
class TaskStateManagerImpl {
  private machines: Map<number, TaskStateMachine> = new Map()
  private deps: TaskStateMachineDeps | null = null
  private globalListeners: Set<(taskId: number, state: TaskStateData) => void> = new Set()
  private initializationListeners: Set<() => void> = new Set()

  /**
   * Initialize the manager with dependencies from SocketContext
   * This MUST be called before using any other methods
   */
  initialize(deps: TaskStateMachineDeps): void {
    this.deps = deps
    this.notifyInitializationListeners()
  }

  /**
   * Check if manager is initialized
   */
  isInitialized(): boolean {
    return this.deps !== null
  }

  /**
   * Subscribe to initialization changes.
   *
   * Hooks may render before ChatStreamProvider initializes the manager. This
   * lets them re-render once dependencies are available instead of getting
   * stuck with an uninitialized snapshot.
   */
  subscribeInitialization(listener: () => void): () => void {
    this.initializationListeners.add(listener)
    return () => {
      this.initializationListeners.delete(listener)
    }
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
      this.notifyGlobalListeners(state.taskId, state)
    })

    return machine
  }

  /**
   * Get an existing TaskStateMachine (returns undefined if not exists)
   */
  get(taskId: number): TaskStateMachine | undefined {
    return this.machines.get(taskId)
  }

  handleTaskStatus(taskId: number, taskStatus: ApiTaskStatus, updatedAt?: string): TaskStateData {
    const machine = this.getOrCreate(taskId)
    machine.handleTaskStatus(taskStatus, updatedAt)
    return machine.getState()
  }

  syncTaskDetail(taskDetail: Pick<TaskDetail, 'id' | 'status' | 'updated_at'>): void {
    const machine = this.getOrCreate(taskDetail.id)
    machine.loadTask(taskDetail)
  }

  async checkHealthAll(reason: TaskRecoveryReason): Promise<void> {
    const uniqueMachines = new Set(this.machines.values())
    await Promise.allSettled(Array.from(uniqueMachines).map(machine => machine.checkHealth(reason)))
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
   * Migrate state from a temporary task ID to the real server task ID.
   * The real task ID becomes the only active key so recovery never talks to the
   * backend with a local placeholder ID.
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

    tempMachine.renameTaskId(realTaskId)
    this.machines.delete(tempTaskId)
    this.machines.set(realTaskId, tempMachine)
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

  private notifyInitializationListeners(): void {
    this.initializationListeners.forEach(listener => {
      try {
        listener()
      } catch (err) {
        console.error('[TaskStateManager] Error in initialization listener:', err)
      }
    })
  }
}

// Export singleton instance
export const taskStateManager = new TaskStateManagerImpl()

// Export class type for testing
export type { TaskStateManagerImpl }
