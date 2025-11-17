// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Task, TaskStatus, TaskViewStatus, TaskViewStatusMap } from '@/types/api';

const STORAGE_KEY = 'task_view_status';
const MAX_RECORDS = 5000;

/**
 * Get task view status map from localStorage
 */
export function getTaskViewStatusMap(): TaskViewStatusMap {
  if (typeof window === 'undefined') return {};

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch (error) {
    console.error('Failed to read task view status:', error);
    return {};
  }
}

/**
 * Save task view status map to localStorage
 */
function saveTaskViewStatusMap(statusMap: TaskViewStatusMap): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(statusMap));
  } catch (error) {
    console.error('Failed to save task view status:', error);
  }
}

/**
 * Prune old view status records using LRU strategy
 */
function pruneOldViewStatus(statusMap: TaskViewStatusMap): TaskViewStatusMap {
  const entries = Object.entries(statusMap);
  if (entries.length <= MAX_RECORDS) return statusMap;

  // Sort by viewed time (newest first) and keep only MAX_RECORDS
  const sorted = entries.sort((a, b) =>
    new Date(b[1].viewedAt).getTime() - new Date(a[1].viewedAt).getTime()
  );

  return Object.fromEntries(sorted.slice(0, MAX_RECORDS));
}

/**
 * Mark a task as viewed
 */
export function markTaskAsViewed(taskId: number, status: TaskStatus): void {
  const statusMap = getTaskViewStatusMap();

  statusMap[taskId] = {
    viewedAt: new Date().toISOString(),
    status,
  };

  const prunedMap = pruneOldViewStatus(statusMap);
  saveTaskViewStatusMap(prunedMap);
}

/**
 * Get view status for a specific task
 */
export function getTaskViewStatus(taskId: number): TaskViewStatus | null {
  const statusMap = getTaskViewStatusMap();
  return statusMap[taskId] || null;
}

/**
 * Check if a task is unread
 */
export function isTaskUnread(task: Task): boolean {
  // Only show unread badge for terminal states
  if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
    return false;
  }

  const viewStatus = getTaskViewStatus(task.id);

  // If never viewed, it's unread
  if (!viewStatus) return true;

  // If task was updated after last view, it's unread
  // This handles the case where a task is re-run
  const taskUpdatedAt = new Date(task.completed_at || task.updated_at);
  const viewedAt = new Date(viewStatus.viewedAt);

  return taskUpdatedAt > viewedAt;
}

/**
 * Mark all tasks as viewed
 */
export function markAllTasksAsViewed(tasks: Task[]): void {
  const statusMap = getTaskViewStatusMap();

  tasks.forEach(task => {
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
      statusMap[task.id] = {
        viewedAt: new Date().toISOString(),
        status: task.status,
      };
    }
  });

  const prunedMap = pruneOldViewStatus(statusMap);
  saveTaskViewStatusMap(prunedMap);
}

/**
 * Get unread count for a list of tasks
 */
export function getUnreadCount(tasks: Task[]): number {
  return tasks.filter(isTaskUnread).length;
}
