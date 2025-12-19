// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * useTaskEvents Hook
 *
 * Listens for real-time task list events via Socket.IO.
 * Handles task creation, deletion, rename, status changes, and sharing.
 */

import { useCallback, useEffect } from 'react';
import { useSocket } from '@/contexts/SocketContext';
import {
  ServerEvents,
  TaskCreatedPayload,
  TaskDeletedPayload,
  TaskRenamedPayload,
  TaskStatusPayload,
  TaskSharedPayload,
  UnreadCountPayload,
} from '@/types/socket';

interface UseTaskEventsOptions {
  /** Callback when a new task is created */
  onTaskCreated?: (task: TaskCreatedPayload) => void;
  /** Callback when a task is deleted */
  onTaskDeleted?: (data: TaskDeletedPayload) => void;
  /** Callback when a task is renamed */
  onTaskRenamed?: (data: TaskRenamedPayload) => void;
  /** Callback when task status changes */
  onTaskStatus?: (data: TaskStatusPayload) => void;
  /** Callback when a task is shared with user */
  onTaskShared?: (data: TaskSharedPayload) => void;
  /** Callback when unread count changes */
  onUnreadCount?: (data: UnreadCountPayload) => void;
}

/**
 * Hook to listen for real-time task events
 *
 * @example
 * ```tsx
 * useTaskEvents({
 *   onTaskCreated: (task) => {
 *     // Add task to list
 *     setTasks(prev => [task, ...prev])
 *   },
 *   onTaskDeleted: ({ task_id }) => {
 *     // Remove task from list
 *     setTasks(prev => prev.filter(t => t.id !== task_id))
 *   }
 * })
 * ```
 */
export function useTaskEvents(options: UseTaskEventsOptions = {}): void {
  const { socket, isConnected } = useSocket();

  const handleTaskCreated = useCallback(
    (data: TaskCreatedPayload) => {
      options.onTaskCreated?.(data);
    },
    [options.onTaskCreated]
  );

  const handleTaskDeleted = useCallback(
    (data: TaskDeletedPayload) => {
      options.onTaskDeleted?.(data);
    },
    [options.onTaskDeleted]
  );

  const handleTaskRenamed = useCallback(
    (data: TaskRenamedPayload) => {
      options.onTaskRenamed?.(data);
    },
    [options.onTaskRenamed]
  );

  const handleTaskStatus = useCallback(
    (data: TaskStatusPayload) => {
      options.onTaskStatus?.(data);
    },
    [options.onTaskStatus]
  );

  const handleTaskShared = useCallback(
    (data: TaskSharedPayload) => {
      options.onTaskShared?.(data);
    },
    [options.onTaskShared]
  );

  const handleUnreadCount = useCallback(
    (data: UnreadCountPayload) => {
      options.onUnreadCount?.(data);
    },
    [options.onUnreadCount]
  );

  useEffect(() => {
    if (!socket || !isConnected) return;

    // Register event listeners
    socket.on(ServerEvents.TASK_CREATED, handleTaskCreated);
    socket.on(ServerEvents.TASK_DELETED, handleTaskDeleted);
    socket.on(ServerEvents.TASK_RENAMED, handleTaskRenamed);
    socket.on(ServerEvents.TASK_STATUS, handleTaskStatus);
    socket.on(ServerEvents.TASK_SHARED, handleTaskShared);
    socket.on(ServerEvents.UNREAD_COUNT, handleUnreadCount);

    return () => {
      // Cleanup event listeners
      socket.off(ServerEvents.TASK_CREATED, handleTaskCreated);
      socket.off(ServerEvents.TASK_DELETED, handleTaskDeleted);
      socket.off(ServerEvents.TASK_RENAMED, handleTaskRenamed);
      socket.off(ServerEvents.TASK_STATUS, handleTaskStatus);
      socket.off(ServerEvents.TASK_SHARED, handleTaskShared);
      socket.off(ServerEvents.UNREAD_COUNT, handleUnreadCount);
    };
  }, [
    socket,
    isConnected,
    handleTaskCreated,
    handleTaskDeleted,
    handleTaskRenamed,
    handleTaskStatus,
    handleTaskShared,
    handleUnreadCount,
  ]);
}

/**
 * Hook to get task connection status
 */
export function useTaskConnectionStatus(): {
  isConnected: boolean;
  reconnectAttempts: number;
} {
  const { isConnected, reconnectAttempts } = useSocket();
  return { isConnected, reconnectAttempts };
}
