// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
  useRef,
  useCallback,
} from 'react';
import { Task, TaskDetail, TaskStatus } from '@/types/api';
import { taskApis } from '@/apis/tasks';
import { ApiError } from '@/apis/client';
import { notifyTaskCompletion } from '@/utils/notification';
import {
  markTaskAsViewed,
  getUnreadCount,
  markAllTasksAsViewed,
  initializeTaskViewStatus,
  getTaskViewStatus,
} from '@/utils/taskViewStatus';
import { useSocket } from '@/contexts/SocketContext';
import { TaskCreatedPayload, TaskInvitedPayload, TaskStatusPayload } from '@/types/socket';

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
  markTaskAsViewed: (taskId: number, status: TaskStatus, taskTimestamp?: string) => void;
  getUnreadCount: (tasks: Task[]) => number;
  markAllTasksAsViewed: () => void;
  viewStatusVersion: number;
  // Access denied state for 403 errors when accessing shared tasks
  accessDenied: boolean;
  clearAccessDenied: () => void;
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
  // Access denied state for 403 errors when accessing shared tasks
  const [accessDenied, setAccessDenied] = useState<boolean>(false);

  // Track task status for notification
  const taskStatusMapRef = useRef<Map<number, TaskStatus>>(new Map());

  // WebSocket connection for real-time task updates
  const { registerTaskHandlers, isConnected, leaveTask, joinTask } = useSocket();

  // Track previous task ID for leaving WebSocket room when switching tasks
  const previousTaskIdRef = useRef<number | null>(null);

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
      setTasks(prev => [...prev, ...result.items]);
      setLoadedPages(prev =>
        Array.from(new Set([...prev, ...(result.pages || [])])).sort((a, b) => a - b)
      );
      setHasMore(result.hasMore);
    }
    // On error, preserve existing data without clearing
    setLoadingMore(false);
  };

  // Refresh all loaded pages
  const refreshTasks = async () => {
    setTaskLoading(true);
    const result = await loadPages(loadedPages, false);

    // Only update tasks if no error occurred - preserve existing data on network error
    if (!result.error) {
      setTasks(result.items);
      setLoadedPages(result.pages || []);
      setHasMore(result.hasMore);

      // Initialize task view status on first load (if not already initialized)
      if (result.items.length > 0) {
        initializeTaskViewStatus(result.items);
      }
    } else {
      // On error, preserve existing data without clearing
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

  // Handle new task created via WebSocket
  const handleTaskCreated = useCallback((data: TaskCreatedPayload) => {
    console.log('[TaskContext] Received task:created event via WebSocket:', data);

    // Check if task already exists in the list
    setTasks(prev => {
      const exists = prev.some(task => task.id === data.task_id);
      if (exists) {
        console.log(`[TaskContext] Task ${data.task_id} already exists, skipping`);
        return prev;
      }

      // Create a new task object from the WebSocket payload
      // Note: Some fields use empty string as default since Task interface requires string type
      // For streaming tasks, set initial status to RUNNING since the task is already being processed
      const newTask: Task = {
        id: data.task_id,
        title: data.title,
        team_id: data.team_id,
        git_url: '',
        git_repo: '',
        git_repo_id: 0,
        git_domain: '',
        branch_name: '',
        prompt: '',
        status: 'RUNNING' as TaskStatus,
        task_type: 'chat',
        progress: 0,
        batch: 0,
        result: {},
        error_message: '',
        user_id: 0,
        user_name: '',
        created_at: data.created_at,
        updated_at: data.created_at,
        completed_at: '',
        is_group_chat: false,
      };

      // Initialize view status for the new task
      initializeTaskViewStatus([newTask]);

      console.log(`[TaskContext] Added new task ${data.task_id} via WebSocket`);
      return [newTask, ...prev];
    });
  }, []);

  // Handle user invited to group chat via WebSocket
  const handleTaskInvited = useCallback((data: TaskInvitedPayload) => {
    console.log('[TaskContext] Received task:invited event via WebSocket:', data);

    // Check if task already exists in the list
    setTasks(prev => {
      const exists = prev.some(task => task.id === data.task_id);
      if (exists) {
        console.log(`[TaskContext] Task ${data.task_id} already exists (invited), skipping`);
        return prev;
      }

      // Create a new task object from the WebSocket payload for invited group chat
      // For streaming tasks, set initial status to RUNNING since the task is already being processed
      const newTask: Task = {
        id: data.task_id,
        title: data.title,
        team_id: data.team_id,
        git_url: '',
        git_repo: '',
        git_repo_id: 0,
        git_domain: '',
        branch_name: '',
        prompt: '',
        status: 'RUNNING' as TaskStatus,
        task_type: 'chat',
        progress: 0,
        batch: 0,
        result: {},
        error_message: '',
        user_id: 0,
        user_name: '',
        created_at: data.created_at,
        updated_at: data.created_at,
        completed_at: '',
        is_group_chat: data.is_group_chat,
      };

      // Initialize view status for the new task
      initializeTaskViewStatus([newTask]);

      console.log(`[TaskContext] Added invited group chat task ${data.task_id} via WebSocket`);
      return [newTask, ...prev];
    });
  }, []);

  // Handle task status update via WebSocket
  const handleTaskStatus = useCallback(
    (data: TaskStatusPayload) => {
      console.log('[TaskContext] Received task:status event via WebSocket:', data);

      const now = new Date().toISOString();
      // Use completed_at from WebSocket payload for terminal states, or generate one
      const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED'];
      const isTerminalState = terminalStates.includes(data.status);
      const completedAt = isTerminalState ? data.completed_at || now : undefined;

      // Use a ref-like pattern to capture isGroupChatTask from within setTasks
      // We need to handle the logic inside setTasks to ensure we have the correct task data
      setTasks(prev => {
        const taskIndex = prev.findIndex(task => task.id === data.task_id);
        if (taskIndex === -1) {
          console.log(
            `[TaskContext] Task ${data.task_id} not found in list, skipping status update`
          );
          return prev;
        }

        const existingTask = prev[taskIndex];
        const isGroupChatTask = existingTask.is_group_chat === true;

        // Update task status, progress, and completed_at for terminal states
        const updatedTask = {
          ...existingTask,
          status: data.status as TaskStatus,
          progress: data.progress ?? existingTask.progress,
          updated_at: now,
          // Update completed_at for terminal states
          ...(completedAt && { completed_at: completedAt }),
        };

        // For group chat tasks, move the task to the top of the list
        // This ensures new messages in group chats are visible
        if (isGroupChatTask) {
          const updatedTasks = [...prev];
          updatedTasks.splice(taskIndex, 1); // Remove from current position
          updatedTasks.unshift(updatedTask); // Add to the beginning
          console.log(`[TaskContext] Moved group chat task ${data.task_id} to top of list`);

          // Schedule the side effects for after state update
          // For group chat tasks, trigger re-render to show unread indicator
          // Only if user is not currently viewing this task
          setTimeout(() => {
            if (!selectedTask || selectedTask.id !== data.task_id) {
              setViewStatusVersion(v => v + 1);
              console.log(
                `[TaskContext] Triggered re-render for group chat task ${data.task_id} unread indicator`
              );
            }
          }, 0);

          return updatedTasks;
        }

        // For non-group chat tasks, update in place
        const updatedTasks = [...prev];
        updatedTasks[taskIndex] = updatedTask;

        console.log(
          `[TaskContext] Updated task ${data.task_id} status to ${data.status} via WebSocket`,
          completedAt ? `completed_at=${completedAt}` : ''
        );

        // Schedule the side effects for after state update
        // For non-group-chat tasks reaching terminal state, update viewedAt
        if (isTerminalState && completedAt) {
          setTimeout(() => {
            const existingViewStatus = getTaskViewStatus(data.task_id);
            if (existingViewStatus) {
              // User has previously viewed this task, update viewedAt to match completed_at
              markTaskAsViewed(data.task_id, data.status as TaskStatus, completedAt);
              setViewStatusVersion(v => v + 1);
              console.log(
                `[TaskContext] Updated viewedAt for task ${data.task_id} to match completed_at (user previously viewed)`
              );
            }
          }, 0);
        }

        return updatedTasks;
      });

      // Also update selected task detail if it's the same task
      if (selectedTask && selectedTask.id === data.task_id) {
        setSelectedTaskDetail(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            status: data.status as TaskStatus,
            progress: data.progress ?? prev.progress,
            updated_at: now,
            // Update completed_at for terminal states
            ...(completedAt && { completed_at: completedAt }),
          };
        });
      }
    },
    [selectedTask]
  );
  // Register WebSocket event handlers for real-time task updates
  useEffect(() => {
    // Only register handlers when WebSocket is connected
    if (!isConnected) {
      console.log('[TaskContext] WebSocket not connected, skipping task handler registration');
      return;
    }

    console.log('[TaskContext] Registering WebSocket task handlers');
    const cleanup = registerTaskHandlers({
      onTaskCreated: handleTaskCreated,
      onTaskInvited: handleTaskInvited,
      onTaskStatus: handleTaskStatus,
    });

    return () => {
      console.log('[TaskContext] Cleaning up WebSocket task handlers');
      cleanup();
    };
  }, [isConnected, registerTaskHandlers, handleTaskCreated, handleTaskInvited, handleTaskStatus]);

  // Removed polling - relying entirely on WebSocket real-time updates
  // Task list will be updated via WebSocket events:
  // - task:created - new task created
  // - task:invited - user invited to group chat
  // - task:status - task status/progress updates

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
      // Clear access denied state before fetching
      setAccessDenied(false);
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
      // Check if it's a 403 Forbidden or 404 Not Found error (access denied or task not found)
      // Both cases should show the access denied UI to prevent information leakage
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        console.warn(
          '[TaskContext] Access denied or task not found:',
          selectedTask.id,
          error.status
        );
        setAccessDenied(true);
        setSelectedTaskDetail(null);
        return;
      }
      console.error('Failed to refresh selected task detail:', error);
    }
  };

  // Trigger task detail refresh and manage WebSocket room when selectedTask changes
  useEffect(() => {
    const currentTaskId = selectedTask?.id ?? null;
    const previousTaskId = previousTaskIdRef.current;

    // Leave previous task room if switching to a different task
    if (previousTaskId !== null && previousTaskId !== currentTaskId) {
      console.log(`[TaskContext] Leaving WebSocket room for task ${previousTaskId}`);
      leaveTask(previousTaskId);
    }

    // Update the ref to track current task
    previousTaskIdRef.current = currentTaskId;

    if (selectedTask) {
      // Join the new task room to receive chat:start, chat:chunk, chat:done events
      // This is important for executor tasks (Code page) where the user needs to
      // receive AI response events via WebSocket
      console.log(`[TaskContext] Joining WebSocket room for task ${selectedTask.id}`);
      joinTask(selectedTask.id);

      refreshSelectedTaskDetail(false); // Manual task selection, not auto-refresh
    } else {
      setSelectedTaskDetail(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask, leaveTask, joinTask]);

  // Re-join task room when WebSocket reconnects
  // This handles the case where page is refreshed and selectedTask is set from URL
  // before WebSocket connection is established
  useEffect(() => {
    if (isConnected && selectedTask) {
      console.log(`[TaskContext] WebSocket connected, re-joining room for task ${selectedTask.id}`);
      joinTask(selectedTask.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  // Mark task as viewed when selectedTaskDetail is loaded
  // This ensures we have the correct status and timestamps from the backend
  useEffect(() => {
    if (selectedTaskDetail) {
      const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED'];
      // For terminal states, use task's completed_at/updated_at to ensure viewedAt >= taskUpdatedAt
      // This prevents the "unread" badge from showing due to client/server time differences
      const taskTimestamp = terminalStates.includes(selectedTaskDetail.status)
        ? selectedTaskDetail.completed_at ||
          selectedTaskDetail.updated_at ||
          new Date().toISOString()
        : undefined;

      markTaskAsViewed(selectedTaskDetail.id, selectedTaskDetail.status, taskTimestamp);
      // Trigger re-render to update unread status in sidebar
      setViewStatusVersion(prev => prev + 1);
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

  // Wrapper for markTaskAsViewed that also triggers re-render
  // This ensures the unread dot disappears immediately when a task is clicked
  const handleMarkTaskAsViewed = useCallback(
    (taskId: number, status: TaskStatus, taskTimestamp?: string) => {
      markTaskAsViewed(taskId, status, taskTimestamp);
      // Trigger re-render to update unread status in sidebar
      setViewStatusVersion(prev => prev + 1);
    },
    []
  );

  // Clear access denied state (called when navigating away or starting new task)
  const clearAccessDenied = useCallback(() => {
    setAccessDenied(false);
  }, []);

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
        markTaskAsViewed: handleMarkTaskAsViewed,
        getUnreadCount,
        markAllTasksAsViewed: handleMarkAllTasksAsViewed,
        viewStatusVersion,
        accessDenied,
        clearAccessDenied,
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
