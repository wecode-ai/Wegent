// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Task State Manager
 *
 * Singleton manager for all TaskStateMachine instances.
 * Provides centralized access and lifecycle management.
 */

import {
  TaskStateMachine,
  type SocketContextInterface,
  type TaskStateData,
} from './TaskStateMachine'

/**
 * Global state change listener
 */
export type GlobalStateListener = (taskId: number, state: TaskStateData) => void

/**
 * Task State Manager Singleton
 *
 * Manages all TaskStateMachine instances and provides:
 * - Centralized access via getOrCreate()
 * - Batch recovery via recoverAll()
 * - Lifecycle management via cleanup()
 */
class TaskStateManagerClass {
  private _taskStates: Map<number, TaskStateMachine> = new Map()
  private _socketContext: SocketContextInterface | null = null
  private _globalListeners: Set<GlobalStateListener> = new Set()

  /**
   * Set socket context for all TaskStateMachine instances
   * Called once during app initialization
   */
  setSocketContext(context: SocketContextInterface): void {
    this._socketContext = context

    // Update existing instances
    for (const machine of this._taskStates.values()) {
      machine.setSocketContext(context)
    }
  }

  /**
   * Get or create a TaskStateMachine for a task
   */
  getOrCreate(taskId: number): TaskStateMachine {
    let machine = this._taskStates.get(taskId)

    if (!machine) {
      machine = new TaskStateMachine(taskId)

      if (this._socketContext) {
        machine.setSocketContext(this._socketContext)
      }

      // Subscribe to state changes for global notification
      machine.subscribe(state => {
        this._notifyGlobal(taskId, state)
      })

      this._taskStates.set(taskId, machine)
      console.log(`[TaskStateManager] Created TaskStateMachine for task ${taskId}`)
    }

    return machine
  }

  /**
   * Get an existing TaskStateMachine (without creating)
   */
  get(taskId: number): TaskStateMachine | undefined {
    return this._taskStates.get(taskId)
  }

  /**
   * Check if a TaskStateMachine exists
   */
  has(taskId: number): boolean {
    return this._taskStates.has(taskId)
  }

  /**
   * Recover all active tasks
   * Called after WebSocket reconnection
   */
  async recoverAll(options?: { force?: boolean }): Promise<void> {
    const machines = Array.from(this._taskStates.values())
    console.log(
      `[TaskStateManager] Recovering ${machines.length} tasks...`,
      options?.force ? '(force)' : ''
    )

    const promises = machines.map(machine =>
      machine.recover({ force: options?.force ?? true }).catch(err => {
        console.error(`[TaskStateManager] Failed to recover task ${machine.taskId}:`, err)
      })
    )

    await Promise.all(promises)
    console.log(`[TaskStateManager] Recovery complete`)
  }

  /**
   * Cleanup a TaskStateMachine
   */
  cleanup(taskId: number): void {
    const machine = this._taskStates.get(taskId)
    if (machine) {
      machine.leave()
      this._taskStates.delete(taskId)
      console.log(`[TaskStateManager] Cleaned up TaskStateMachine for task ${taskId}`)
    }
  }

  /**
   * Cleanup all TaskStateMachines
   */
  cleanupAll(): void {
    for (const machine of this._taskStates.values()) {
      machine.leave()
    }
    this._taskStates.clear()
    console.log(`[TaskStateManager] Cleaned up all TaskStateMachines`)
  }

  /**
   * Get all active task IDs
   */
  getActiveTaskIds(): number[] {
    return Array.from(this._taskStates.keys())
  }

  /**
   * Get all tasks that are currently streaming
   */
  getStreamingTaskIds(): number[] {
    return Array.from(this._taskStates.entries())
      .filter(([_, machine]) => machine.isStreaming)
      .map(([taskId]) => taskId)
  }

  /**
   * Subscribe to global state changes (all tasks)
   */
  subscribeGlobal(listener: GlobalStateListener): () => void {
    this._globalListeners.add(listener)
    return () => {
      this._globalListeners.delete(listener)
    }
  }

  /**
   * Find task by subtask ID
   */
  findTaskBySubtaskId(subtaskId: number): TaskStateMachine | undefined {
    for (const machine of this._taskStates.values()) {
      if (machine.streamingSubtaskId === subtaskId) {
        return machine
      }
      // Also check messages for completed subtasks
      for (const msg of machine.messages.values()) {
        if (msg.subtaskId === subtaskId) {
          return machine
        }
      }
    }
    return undefined
  }

  /**
   * Notify global listeners
   */
  private _notifyGlobal(taskId: number, state: TaskStateData): void {
    this._globalListeners.forEach(listener => {
      try {
        listener(taskId, state)
      } catch (err) {
        console.error(`[TaskStateManager] Global listener error:`, err)
      }
    })
  }
}

// Export singleton instance
export const taskStateManager = new TaskStateManagerClass()

// Export types
export type { RecoverOptions, TaskStateData } from './TaskStateMachine'
