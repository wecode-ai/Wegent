// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Task, TaskStatus, TaskViewStatus, TaskViewStatusMap } from '@/types/api'

const STORAGE_KEY = 'task_view_status'
const INIT_FLAG_KEY = 'task_view_status_initialized'
const MAX_RECORDS = 5000

/**
 * Get task view status map from localStorage
 */
export function getTaskViewStatusMap(): TaskViewStatusMap {
  if (typeof window === 'undefined') return {}

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch (error) {
    console.error('Failed to read task view status:', error)
    return {}
  }
}

/**
 * Save task view status map to localStorage
 */
function saveTaskViewStatusMap(statusMap: TaskViewStatusMap): void {
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(statusMap))
  } catch (error) {
    console.error('Failed to save task view status:', error)
  }
}

/**
 * Prune old view status records using LRU strategy
 */
function pruneOldViewStatus(statusMap: TaskViewStatusMap): TaskViewStatusMap {
  const entries = Object.entries(statusMap)
  if (entries.length <= MAX_RECORDS) return statusMap

  // Sort by viewed time (newest first) and keep only MAX_RECORDS
  const sorted = entries.sort(
    (a, b) => new Date(b[1].viewedAt).getTime() - new Date(a[1].viewedAt).getTime()
  )

  return Object.fromEntries(sorted.slice(0, MAX_RECORDS))
}

/**
 * Mark a task as viewed
 * @param taskId - The task ID
 * @param status - The task status
 * @param taskTimestamp - Optional: Use task's timestamp (completed_at or updated_at) instead of current time.
 *                        This is important when the task reaches terminal state while user is viewing it,
 *                        to avoid time sync issues between client and server.
 */
export function markTaskAsViewed(taskId: number, status: TaskStatus, taskTimestamp?: string): void {
  const statusMap = getTaskViewStatusMap()

  // Use task timestamp if provided, otherwise use current time
  // When task timestamp is provided, we use it to ensure viewedAt >= taskUpdatedAt
  // This prevents the "unread" badge from showing due to client/server time differences
  const newViewedAt = taskTimestamp || new Date().toISOString()

  // Get existing view status to ensure we don't set an older viewedAt
  // This prevents the case where clicking a task sets viewedAt, but then
  // loading task detail with a slightly different timestamp resets it to an older value
  const existingStatus = statusMap[taskId]
  let viewedAt = newViewedAt

  if (existingStatus) {
    const existingTime = new Date(existingStatus.viewedAt).getTime()
    const newTime = new Date(newViewedAt).getTime()
    // Keep the newer timestamp to ensure the task stays marked as read
    if (existingTime > newTime) {
      viewedAt = existingStatus.viewedAt
    }
  }

  statusMap[taskId] = {
    viewedAt,
    status,
  }

  const prunedMap = pruneOldViewStatus(statusMap)
  saveTaskViewStatusMap(prunedMap)
}

/**
 * Get view status for a specific task
 */
export function getTaskViewStatus(taskId: number): TaskViewStatus | null {
  const statusMap = getTaskViewStatusMap()
  return statusMap[taskId] || null
}

/**
 * Check if a task is unread
 */
export function isTaskUnread(task: Task): boolean {
  // For group chat tasks, check if there are new messages (any status)
  if (task.is_group_chat) {
    const viewStatus = getTaskViewStatus(task.id)

    // If never viewed, it's unread
    if (!viewStatus) {
      return true
    }

    // Compare task's updated_at with last viewed time
    const taskUpdatedAt = new Date(task.updated_at).getTime()
    const viewedAt = new Date(viewStatus.viewedAt).getTime()

    // Use a 1-second tolerance to handle minor timestamp differences
    const TOLERANCE_MS = 1000
    return taskUpdatedAt > viewedAt + TOLERANCE_MS
  }

  // For non-group-chat tasks, only show unread badge for terminal states
  if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
    return false
  }

  const viewStatus = getTaskViewStatus(task.id)

  // If never viewed, it's unread
  if (!viewStatus) {
    return true
  }

  // If task was updated after last view, it's unread
  // This handles the case where a task is re-run
  const taskUpdatedAt = new Date(task.completed_at || task.updated_at).getTime()
  const viewedAt = new Date(viewStatus.viewedAt).getTime()

  // Use a 1-second tolerance to handle minor timestamp differences
  // between task list and task detail responses
  const TOLERANCE_MS = 1000
  const isUnread = taskUpdatedAt > viewedAt + TOLERANCE_MS
  return isUnread
}

/**
 * Mark all tasks as viewed
 * Uses task's own timestamp (completed_at or updated_at) to avoid client/server time sync issues
 */
export function markAllTasksAsViewed(tasks: Task[]): void {
  const statusMap = getTaskViewStatusMap()

  tasks.forEach(task => {
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
      // Use task's timestamp to ensure viewedAt >= taskUpdatedAt
      const viewedAt = task.completed_at || task.updated_at
      statusMap[task.id] = {
        viewedAt,
        status: task.status,
      }
    }
  })

  const prunedMap = pruneOldViewStatus(statusMap)
  saveTaskViewStatusMap(prunedMap)
}

/**
 * Get unread count for a list of tasks
 */
export function getUnreadCount(tasks: Task[]): number {
  return tasks.filter(isTaskUnread).length
}

/**
 * Check if the system has been initialized
 */
function isInitialized(): boolean {
  if (typeof window === 'undefined') return true

  try {
    return localStorage.getItem(INIT_FLAG_KEY) === 'true'
  } catch (error) {
    console.error('Failed to check initialization status:', error)
    return true // Assume initialized on error to avoid mass-marking
  }
}

/**
 * Mark system as initialized
 */
function markAsInitialized(): void {
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(INIT_FLAG_KEY, 'true')
  } catch (error) {
    console.error('Failed to mark as initialized:', error)
  }
}

/**
 * Initialize task view status for first-time users or after cache clear
 * Auto-mark all existing terminal-state tasks as viewed
 */
export function initializeTaskViewStatus(tasks: Task[]): void {
  // Skip if already initialized
  if (isInitialized()) return

  // Mark all existing terminal-state tasks as viewed
  const statusMap = getTaskViewStatusMap()
  let hasChanges = false

  tasks.forEach(task => {
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
      // Use task completion/update time as viewed time to avoid showing as unread
      const viewedAt = task.completed_at || task.updated_at
      statusMap[task.id] = {
        viewedAt,
        status: task.status,
      }
      hasChanges = true
    }
  })

  if (hasChanges) {
    const prunedMap = pruneOldViewStatus(statusMap)
    saveTaskViewStatusMap(prunedMap)
  }

  // Mark as initialized
  markAsInitialized()
}
