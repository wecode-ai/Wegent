// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode, useRef } from 'react';
import { Task, TaskDetail, TaskStatus } from '@/types/api';
import { taskApis } from '@/apis/tasks';
import { notifyTaskCompletion } from '@/utils/notification';
import {
  markTaskAsViewed,
  getUnreadCount,
  markAllTasksAsViewed,
  initializeTaskViewStatus,
} from '@/utils/taskViewStatus';

type TaskContextType = {
  tasks: Task[];
  taskLoading: boolean;
  selectedTask: Task | null;
  selectedTaskDetail: TaskDetail | null;
  setSelectedTask: (task: Task | null) => void;
  refreshTasks: () => void;
  refreshSelectedTaskDetail: (isAutoRefresh?: boolean) => void;
  loadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  searchTasks: (term: string) => Promise<void>;
  isSearching: boolean;
  isSearchResult: boolean;
  markTaskAsViewed: (taskId: number, status: TaskStatus) => void;
  getUnreadCount: (tasks: Task[]) => number;
  markAllTasksAsViewed: () => void;
  viewStatusVersion: number;
  /** Whether there was a network error during the last fetch */
  hasNetworkError: boolean;
};

const TaskContext = createContext<TaskContextType | undefined>(undefined);

// Export the context so it can be used with useContext directly
export { TaskContext };

export const TaskContextProvider = ({ children }: { children: ReactNode }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskLoading, setTaskLoading] = useState<boolean>(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskDetail | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [isSearchResult, setIsSearchResult] = useState<boolean>(false);
  const [viewStatusVersion, setViewStatusVersion] = useState<number>(0);
  const [hasNetworkError, setHasNetworkError] = useState<boolean>(false);

  // Track task status for notification
  const taskStatusMapRef = useRef<Map<number, TaskStatus>>(new Map());

  // Pagination related
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedPages, setLoadedPages] = useState([1]);
  const limit = 50;

  // Batch load specified pages (only responsible for data requests and responses, does not handle loading state)
  // Returns { items, hasMore, pages, error } - error is true if network request failed
  const loadPages = async (pagesArr: number[], _append = false) => {
    if (pagesArr.length === 0) return { items: [], hasMore: false, error: false };
    const requests = pagesArr.map(p => taskApis.getTasksLite({ page: p, limit }));
    try {
      const results = await Promise.all(requests);
      const allItems = results.flatMap(res => res.items || []);
      const lastPageItems = results[results.length - 1]?.items || [];
      return {
        items: allItems,
        hasMore: lastPageItems.length === limit,
        pages: pagesArr,
        error: false,
      };
    } catch (err) {
      console.error('[TaskContext] Failed to load pages:', err);
      // Return error flag instead of empty data
      return { items: [], hasMore: true, pages: pagesArr, error: true };
    }
  };

  // Load more
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = (loadedPages[loadedPages.length - 1] || 1) + 1;
    const result = await loadPages([nextPage], true);

    // Only update if no error occurred
    if (!result.error) {
      setHasNetworkError(false);
      setTasks(prev => [...prev, ...result.items]);
      setLoadedPages(prev =>
        Array.from(new Set([...prev, ...(result.pages || [])])).sort((a, b) => a - b)
      );
      setHasMore(result.hasMore);
    } else {
      // On error, set network error flag but don't clear existing data
      setHasNetworkError(true);
    }
    setLoadingMore(false);
  };

  // Refresh all loaded pages
  const refreshTasks = async () => {
    setTaskLoading(true);
    const result = await loadPages(loadedPages, false);

    // Only update tasks if no error occurred - preserve existing data on network error
    if (!result.error) {
      setHasNetworkError(false);
      setTasks(result.items);
      setLoadedPages(result.pages || []);
      setHasMore(result.hasMore);

      // Initialize task view status on first load (if not already initialized)
      if (result.items.length > 0) {
        initializeTaskViewStatus(result.items);
      }
    } else {
      // On error, set network error flag but don't clear existing data
      // This ensures the list remains visible and polling continues
      setHasNetworkError(true);
      console.warn('[TaskContext] Network error during refresh, preserving existing task list');
    }

    setTaskLoading(false);
  };
  // Monitor task status changes and send notifications
  useEffect(() => {
    tasks.forEach(task => {
      const previousStatus = taskStatusMapRef.current.get(task.id);
      const currentStatus = task.status;

      // Check if status changed from running to completed/failed
      if (previousStatus && previousStatus !== currentStatus) {
        const wasRunning = previousStatus === 'RUNNING' || previousStatus === 'PENDING';
        const isCompleted = currentStatus === 'COMPLETED';
        const isFailed = currentStatus === 'FAILED';

        if (wasRunning && (isCompleted || isFailed)) {
          notifyTaskCompletion(task.id, task.title, isCompleted, task.task_type);
        }
      }

      // Update status map
      taskStatusMapRef.current.set(task.id, currentStatus);
    });
  }, [tasks]);

  // Initial load
  useEffect(() => {
    refreshTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only refresh periodically when there are unfinished tasks OR when there's a network error
  // This ensures polling continues even after network errors to recover when connection is restored
  useEffect(() => {
    const hasIncompleteTasks = tasks.some(
      task =>
        task.status !== 'COMPLETED' &&
        task.status !== 'FAILED' &&
        task.status !== 'CANCELLED' &&
        task.status !== 'DELETE'
    );

    let interval: NodeJS.Timeout | null = null;

    // Continue polling if there are incomplete tasks OR if there was a network error
    // This allows recovery when network connection is restored
    if (hasIncompleteTasks || hasNetworkError) {
      interval = setInterval(() => {
        refreshTasks();
      }, 10000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedPages, tasks, hasNetworkError]); // Added hasNetworkError to dependencies

  const refreshSelectedTaskDetail = async (isAutoRefresh: boolean = false) => {
    if (!selectedTask) return;

    // Only check task status during auto-refresh; manual trigger allows viewing completed tasks
    if (
      isAutoRefresh &&
      selectedTaskDetail &&
      (selectedTaskDetail.status === 'COMPLETED' ||
        selectedTaskDetail.status === 'FAILED' ||
        selectedTaskDetail.status === 'CANCELLED' ||
        selectedTaskDetail.status === 'DELETE')
    ) {
      return;
    }

    try {
      const updatedTaskDetail = await taskApis.getTaskDetail(selectedTask.id);

      // Extract workbench data from subtasks
      let workbenchData = null;
      if (Array.isArray(updatedTaskDetail.subtasks) && updatedTaskDetail.subtasks.length > 0) {
        for (const sub of updatedTaskDetail.subtasks) {
          const result = sub.result;
          if (result && typeof result === 'object') {
            if (result.workbench) {
              workbenchData = result.workbench;
            } else if (result.value && typeof result.value === 'object' && result.value.workbench) {
              workbenchData = result.value.workbench;
            } else if (typeof result.value === 'string') {
              try {
                const parsedValue = JSON.parse(result.value);
                if (parsedValue.workbench) {
                  workbenchData = parsedValue.workbench;
                }
              } catch (_e) {
                // Not valid JSON, ignore
              }
            }
          }
        }
      }

      // Create a new object with workbench data to ensure React detects the change
      const taskDetailWithWorkbench = {
        ...updatedTaskDetail,
        workbench: workbenchData || updatedTaskDetail.workbench,
      };

      setSelectedTaskDetail(taskDetailWithWorkbench);
    } catch (error) {
      console.error('Failed to refresh selected task detail:', error);
    }
  };

  // Mark task as viewed when selected OR when currently viewing task reaches terminal state
  useEffect(() => {
    if (selectedTask) {
      // Mark task as viewed when selected
      markTaskAsViewed(selectedTask.id, selectedTask.status);
      refreshSelectedTaskDetail(false); // Manual task selection, not auto-refresh
    } else {
      setSelectedTaskDetail(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask]);

  // Auto-mark as viewed when currently viewing task reaches terminal state
  useEffect(() => {
    if (selectedTaskDetail) {
      const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED'];
      if (terminalStates.includes(selectedTaskDetail.status)) {
        // Use TaskDetail's completed_at/updated_at as the timestamp for marking as viewed
        // This ensures consistency with isTaskUnread which uses Task's timestamps
        // Note: TaskDetail now has these fields from the backend
        const taskTimestamp =
          selectedTaskDetail.completed_at ||
          selectedTaskDetail.updated_at ||
          new Date().toISOString();

        console.log(`[taskContext] Auto-marking task ${selectedTaskDetail.id} as viewed:`, {
          taskId: selectedTaskDetail.id,
          taskStatus: selectedTaskDetail.status,
          taskDetailCompletedAt: selectedTaskDetail.completed_at,
          taskDetailUpdatedAt: selectedTaskDetail.updated_at,
          usingTimestamp: taskTimestamp,
        });

        markTaskAsViewed(selectedTaskDetail.id, selectedTaskDetail.status, taskTimestamp);
        setViewStatusVersion(prev => prev + 1);
      }
    }
  }, [
    selectedTaskDetail?.status,
    selectedTaskDetail?.id,
    selectedTaskDetail?.completed_at,
    selectedTaskDetail?.updated_at,
  ]);

  // Search tasks
  const searchTasks = async (term: string) => {
    if (!term.trim()) {
      setIsSearchResult(false);
      return refreshTasks();
    }

    setIsSearching(true);
    setIsSearchResult(true);

    try {
      const result = await taskApis.searchTasks(term, { page: 1, limit: 100 });
      setTasks(result.items);
      setHasMore(false); // Search results do not support loading more pages
    } catch (error) {
      console.error('Failed to search tasks:', error);
    } finally {
      setIsSearching(false);
    }
  };

  // Handle marking all tasks as viewed
  const handleMarkAllTasksAsViewed = () => {
    markAllTasksAsViewed(tasks);
    // Trigger re-render by updating version
    setViewStatusVersion(prev => prev + 1);
  };

  return (
    <TaskContext.Provider
      value={{
        tasks,
        taskLoading,
        selectedTask,
        selectedTaskDetail,
        setSelectedTask,
        refreshTasks,
        refreshSelectedTaskDetail,
        loadMore,
        hasMore,
        loadingMore,
        searchTerm,
        setSearchTerm,
        searchTasks,
        isSearching,
        isSearchResult,
        markTaskAsViewed,
        getUnreadCount,
        markAllTasksAsViewed: handleMarkAllTasksAsViewed,
        viewStatusVersion,
        hasNetworkError,
      }}
    >
      {children}
    </TaskContext.Provider>
  );
};
/**
 * useTaskContext must be used within a TaskContextProvider.
 */
export const useTaskContext = () => {
  const context = useContext(TaskContext);
  if (!context) {
    throw new Error('useTaskContext must be used within a TaskContextProvider');
  }
  return context;
};
