// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
  useRef,
  useCallback,
} from 'react'
import { Task, TaskDetail, TaskStatus } from '@/types/api'
import { taskApis } from '@/apis/tasks'
import { ApiError } from '@/apis/client'
import { notifyTaskCompletion } from '@/utils/notification'
import {
  markTaskAsViewed,
  getUnreadCount,
  markAllTasksAsViewed,
  initializeTaskViewStatus,
  getTaskViewStatus,
} from '@/utils/taskViewStatus'
import { useSocket } from '@/contexts/SocketContext'
import {
  TaskCreatedPayload,
  TaskInvitedPayload,
  TaskStatusPayload,
  TaskAppUpdatePayload,
} from '@/types/socket'
import { usePageVisibility } from '@/hooks/usePageVisibility'

type TaskContextType = {
  tasks: Task[]
  groupTasks: Task[]
  personalTasks: Task[]
  taskLoading: boolean
  selectedTask: Task | null
  selectedTaskDetail: TaskDetail | null
  setSelectedTask: (task: Task | null) => void
  refreshTasks: () => void
  refreshGroupTasks: () => void
  refreshPersonalTasks: () => void
  refreshSelectedTaskDetail: (isAutoRefresh?: boolean) => void
  loadMore: () => void
  loadMoreGroupTasks: () => void
  loadMorePersonalTasks: () => void
  hasMore: boolean
  hasMoreGroupTasks: boolean
  hasMorePersonalTasks: boolean
  loadingMore: boolean
  loadingMoreGroupTasks: boolean
  loadingMorePersonalTasks: boolean
  searchTerm: string
  setSearchTerm: (term: string) => void
  searchTasks: (term: string) => Promise<void>
  isSearching: boolean
  isSearchResult: boolean
  markTaskAsViewed: (taskId: number, status: TaskStatus, taskTimestamp?: string) => void
  getUnreadCount: (tasks: Task[]) => number
  markAllTasksAsViewed: () => void
  viewStatusVersion: number
  // Access denied state for 403 errors when accessing shared tasks
  accessDenied: boolean
  clearAccessDenied: () => void
  // Refreshing state for auto-refresh indicator
  isRefreshing: boolean
}

const TaskContext = createContext<TaskContextType | undefined>(undefined)

// Export the context so it can be used with useContext directly
export { TaskContext }

export const TaskContextProvider = ({ children }: { children: ReactNode }) => {
  const [tasks, setTasks] = useState<Task[]>([])
  const [groupTasks, setGroupTasks] = useState<Task[]>([])
  const [personalTasks, setPersonalTasks] = useState<Task[]>([])
  const [taskLoading, setTaskLoading] = useState<boolean>(false)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskDetail | null>(null)
  const [searchTerm, setSearchTerm] = useState<string>('')
  const [isSearching, setIsSearching] = useState<boolean>(false)
  const [isSearchResult, setIsSearchResult] = useState<boolean>(false)
  const [viewStatusVersion, setViewStatusVersion] = useState<number>(0)
  // Access denied state for 403 errors when accessing shared tasks
  const [accessDenied, setAccessDenied] = useState<boolean>(false)
  // Refreshing state for auto-refresh (page visibility or WebSocket reconnect)
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)

  // Track task status for notification
  const taskStatusMapRef = useRef<Map<number, TaskStatus>>(new Map())

  // WebSocket connection for real-time task updates
  const { registerTaskHandlers, isConnected, leaveTask, joinTask, onReconnect } = useSocket()

  // Track previous task ID for leaving WebSocket room when switching tasks
  const previousTaskIdRef = useRef<number | null>(null)

  // Track if auto-refresh is in progress to prevent duplicate requests
  const isAutoRefreshingRef = useRef<boolean>(false)

  // Minimum hidden duration (30 seconds) before triggering refresh on page visibility
  const MIN_HIDDEN_DURATION_MS = 30000

  // Pagination related - legacy combined list
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadedPages, setLoadedPages] = useState([1])
  const limit = 50

  // Pagination related - group tasks
  const [hasMoreGroupTasks, setHasMoreGroupTasks] = useState(true)
  const [loadingMoreGroupTasks, setLoadingMoreGroupTasks] = useState(false)
  const [loadedGroupPages, setLoadedGroupPages] = useState([1])

  // Pagination related - personal tasks
  const [hasMorePersonalTasks, setHasMorePersonalTasks] = useState(true)
  const [loadingMorePersonalTasks, setLoadingMorePersonalTasks] = useState(false)
  const [loadedPersonalPages, setLoadedPersonalPages] = useState([1])

  // Batch load specified pages (only responsible for data requests and responses, does not handle loading state)
  // Returns { items, hasMore, pages, error } - error is true if network request failed
  const loadPages = async (pagesArr: number[], _append = false) => {
    if (pagesArr.length === 0) return { items: [], hasMore: false, error: false }
    const requests = pagesArr.map(p => taskApis.getTasksLite({ page: p, limit }))
    try {
      const results = await Promise.all(requests)
      const allItems = results.flatMap(res => res.items || [])
      const lastPageItems = results[results.length - 1]?.items || []
      return {
        items: allItems,
        hasMore: lastPageItems.length === limit,
        pages: pagesArr,
        error: false,
      }
    } catch (err) {
      console.error('[TaskContext] Failed to load pages:', err)
      // Return error flag instead of empty data
      return { items: [], hasMore: true, pages: pagesArr, error: true }
    }
  }

  // Load group task pages
  const loadGroupPages = async (pagesArr: number[]) => {
    if (pagesArr.length === 0) return { items: [], hasMore: false, error: false }
    const requests = pagesArr.map(p => taskApis.getGroupTasksLite({ page: p, limit }))
    try {
      const results = await Promise.all(requests)
      const allItems = results.flatMap(res => res.items || [])
      const lastPageItems = results[results.length - 1]?.items || []
      return {
        items: allItems,
        hasMore: lastPageItems.length === limit,
        pages: pagesArr,
        error: false,
      }
    } catch (err) {
      console.error('[TaskContext] Failed to load group pages:', err)
      return { items: [], hasMore: true, pages: pagesArr, error: true }
    }
  }

  // Load personal task pages
  const loadPersonalPages = async (pagesArr: number[]) => {
    if (pagesArr.length === 0) return { items: [], hasMore: false, error: false }
    const requests = pagesArr.map(p => taskApis.getPersonalTasksLite({ page: p, limit }))
    try {
      const results = await Promise.all(requests)
      const allItems = results.flatMap(res => res.items || [])
      const lastPageItems = results[results.length - 1]?.items || []
      return {
        items: allItems,
        hasMore: lastPageItems.length === limit,
        pages: pagesArr,
        error: false,
      }
    } catch (err) {
      console.error('[TaskContext] Failed to load personal pages:', err)
      return { items: [], hasMore: true, pages: pagesArr, error: true }
    }
  }

  // Load more
  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const nextPage = (loadedPages[loadedPages.length - 1] || 1) + 1
    const result = await loadPages([nextPage], true)

    // Only update if no error occurred
    if (!result.error) {
      setTasks(prev => {
        const existingIds = new Set(prev.map(t => t.id))
        const newItems = result.items.filter(t => !existingIds.has(t.id))
        return [...prev, ...newItems]
      })
      setLoadedPages(prev =>
        Array.from(new Set([...prev, ...(result.pages || [])])).sort((a, b) => a - b)
      )
      setHasMore(result.hasMore)
    }
    // On error, preserve existing data without clearing
    setLoadingMore(false)
  }

  // Load more group tasks
  const loadMoreGroupTasks = async () => {
    if (loadingMoreGroupTasks || !hasMoreGroupTasks) return
    setLoadingMoreGroupTasks(true)
    const nextPage = (loadedGroupPages[loadedGroupPages.length - 1] || 1) + 1
    const result = await loadGroupPages([nextPage])

    if (!result.error) {
      setGroupTasks(prev => {
        const existingIds = new Set(prev.map(t => t.id))
        const newItems = result.items.filter(t => !existingIds.has(t.id))
        return [...prev, ...newItems]
      })
      setLoadedGroupPages(prev =>
        Array.from(new Set([...prev, ...(result.pages || [])])).sort((a, b) => a - b)
      )
      setHasMoreGroupTasks(result.hasMore)
    }
    setLoadingMoreGroupTasks(false)
  }

  // Load more personal tasks
  const loadMorePersonalTasks = async () => {
    if (loadingMorePersonalTasks || !hasMorePersonalTasks) return
    setLoadingMorePersonalTasks(true)
    const nextPage = (loadedPersonalPages[loadedPersonalPages.length - 1] || 1) + 1
    const result = await loadPersonalPages([nextPage])

    if (!result.error) {
      setPersonalTasks(prev => {
        const existingIds = new Set(prev.map(t => t.id))
        const newItems = result.items.filter(t => !existingIds.has(t.id))
        return [...prev, ...newItems]
      })
      setLoadedPersonalPages(prev =>
        Array.from(new Set([...prev, ...(result.pages || [])])).sort((a, b) => a - b)
      )
      setHasMorePersonalTasks(result.hasMore)
    }
    setLoadingMorePersonalTasks(false)
  }

  // Refresh all loaded pages
  const refreshTasks = async () => {
    setTaskLoading(true)

    // Load group and personal tasks in parallel
    const [groupResult, personalResult] = await Promise.all([
      loadGroupPages(loadedGroupPages),
      loadPersonalPages(loadedPersonalPages),
    ])

    // Update group tasks
    if (!groupResult.error) {
      setGroupTasks(groupResult.items)
      setLoadedGroupPages(groupResult.pages || [1])
      setHasMoreGroupTasks(groupResult.hasMore)
    }

    // Update personal tasks
    if (!personalResult.error) {
      setPersonalTasks(personalResult.items)
      setLoadedPersonalPages(personalResult.pages || [1])
      setHasMorePersonalTasks(personalResult.hasMore)
    }

    // Combine both lists for backward compatibility
    const allTasks = [
      ...(groupResult.error ? groupTasks : groupResult.items),
      ...(personalResult.error ? personalTasks : personalResult.items),
    ]
    setTasks(allTasks)

    // Initialize task view status on first load
    if (allTasks.length > 0) {
      initializeTaskViewStatus(allTasks)
    }

    setTaskLoading(false)
  }

  // Refresh group tasks only
  const refreshGroupTasks = async () => {
    const result = await loadGroupPages([1])
    if (!result.error) {
      setGroupTasks(result.items)
      setLoadedGroupPages([1])
      setHasMoreGroupTasks(result.hasMore)
      // Update combined tasks
      setTasks(prev => {
        const personalOnly = prev.filter(t => !t.is_group_chat)
        return [...result.items, ...personalOnly]
      })
      if (result.items.length > 0) {
        initializeTaskViewStatus(result.items)
      }
    }
  }

  // Refresh personal tasks only
  const refreshPersonalTasks = async () => {
    const result = await loadPersonalPages([1])
    if (!result.error) {
      setPersonalTasks(result.items)
      setLoadedPersonalPages([1])
      setHasMorePersonalTasks(result.hasMore)
      // Update combined tasks
      setTasks(prev => {
        const groupOnly = prev.filter(t => t.is_group_chat)
        return [...groupOnly, ...result.items]
      })
      if (result.items.length > 0) {
        initializeTaskViewStatus(result.items)
      }
    }
  }
  // Monitor task status changes and send notifications
  useEffect(() => {
    tasks.forEach(task => {
      const previousStatus = taskStatusMapRef.current.get(task.id)
      const currentStatus = task.status

      // Check if status changed from running to completed/failed
      if (previousStatus && previousStatus !== currentStatus) {
        const wasRunning = previousStatus === 'RUNNING' || previousStatus === 'PENDING'
        const isCompleted = currentStatus === 'COMPLETED'
        const isFailed = currentStatus === 'FAILED'

        if (wasRunning && (isCompleted || isFailed)) {
          notifyTaskCompletion(task.id, task.title, isCompleted, task.task_type)
        }
      }

      // Update status map
      taskStatusMapRef.current.set(task.id, currentStatus)
    })
  }, [tasks])

  // Initial load
  useEffect(() => {
    refreshTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Auto-refresh task list with debounce protection.
   * Called when page becomes visible after being hidden or when WebSocket reconnects.
   */
  const triggerAutoRefresh = useCallback(async () => {
    // Prevent duplicate refreshes
    if (isAutoRefreshingRef.current) {
      console.log('[TaskContext] Auto-refresh already in progress, skipping')
      return
    }

    isAutoRefreshingRef.current = true
    setIsRefreshing(true)
    console.log('[TaskContext] Starting auto-refresh...')

    try {
      await refreshTasks()
      console.log('[TaskContext] Auto-refresh completed')
    } catch (error) {
      // Silent error handling - don't affect user operation
      console.error('[TaskContext] Auto-refresh failed:', error)
    } finally {
      isAutoRefreshingRef.current = false
      setIsRefreshing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Page visibility recovery: refresh task list when page becomes visible after 30+ seconds hidden
  usePageVisibility({
    minHiddenTime: MIN_HIDDEN_DURATION_MS,
    onVisible: (wasHiddenFor: number) => {
      console.log(`[TaskContext] Page became visible after ${wasHiddenFor}ms hidden`)
      if (wasHiddenFor >= MIN_HIDDEN_DURATION_MS) {
        triggerAutoRefresh()
      }
    },
  })

  // WebSocket reconnect recovery: refresh task list when WebSocket reconnects
  useEffect(() => {
    const unsubscribe = onReconnect(() => {
      console.log('[TaskContext] WebSocket reconnected, refreshing task list...')
      triggerAutoRefresh()
    })

    return unsubscribe
  }, [onReconnect, triggerAutoRefresh])

  // Handle new task created via WebSocket
  const handleTaskCreated = useCallback((data: TaskCreatedPayload) => {
    // Use is_group_chat from WebSocket payload (defaults to false if not provided)
    const isGroupChat = data.is_group_chat ?? false

    // Check if task already exists in the list
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
      is_group_chat: isGroupChat,
    }

    // Initialize view status for the new task
    initializeTaskViewStatus([newTask])

    // Add to correct list based on is_group_chat flag
    if (isGroupChat) {
      // Add to group tasks for group chats
      setGroupTasks(prev => {
        const exists = prev.some(task => task.id === data.task_id)
        if (exists) return prev
        return [newTask, ...prev]
      })
    } else {
      // Add to personal tasks for non-group chats
      setPersonalTasks(prev => {
        const exists = prev.some(task => task.id === data.task_id)
        if (exists) return prev
        return [newTask, ...prev]
      })
    }

    // Also update combined tasks list for backward compatibility
    setTasks(prev => {
      const exists = prev.some(task => task.id === data.task_id)
      if (exists) return prev
      return [newTask, ...prev]
    })
  }, [])

  // Handle user invited to group chat via WebSocket
  const handleTaskInvited = useCallback((data: TaskInvitedPayload) => {
    // Create a new task object from the WebSocket payload for invited group chat
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
    }

    // Initialize view status for the new task
    initializeTaskViewStatus([newTask])

    // Add to group tasks if it's a group chat
    if (data.is_group_chat) {
      setGroupTasks(prev => {
        const exists = prev.some(task => task.id === data.task_id)
        if (exists) return prev
        return [newTask, ...prev]
      })
    } else {
      setPersonalTasks(prev => {
        const exists = prev.some(task => task.id === data.task_id)
        if (exists) return prev
        return [newTask, ...prev]
      })
    }

    // Also update combined tasks list for backward compatibility
    setTasks(prev => {
      const exists = prev.some(task => task.id === data.task_id)
      if (exists) return prev
      return [newTask, ...prev]
    })
  }, [])

  // Handle task status update via WebSocket
  const handleTaskStatus = useCallback(
    (data: TaskStatusPayload) => {
      const now = new Date().toISOString()
      // Use completed_at from WebSocket payload for terminal states, or generate one
      const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED']
      const isTerminalState = terminalStates.includes(data.status)
      const completedAt = isTerminalState ? data.completed_at || now : undefined

      // Helper function to update a task in a list
      const updateTaskInList = (prev: Task[], moveToTop = false) => {
        const taskIndex = prev.findIndex(task => task.id === data.task_id)
        if (taskIndex === -1) return prev

        const existingTask = prev[taskIndex]
        const updatedTask = {
          ...existingTask,
          status: data.status as TaskStatus,
          progress: data.progress ?? existingTask.progress,
          updated_at: now,
          ...(completedAt && { completed_at: completedAt }),
        }

        if (moveToTop) {
          const updatedTasks = [...prev]
          updatedTasks.splice(taskIndex, 1)
          updatedTasks.unshift(updatedTask)
          return updatedTasks
        }

        const updatedTasks = [...prev]
        updatedTasks[taskIndex] = updatedTask
        return updatedTasks
      }

      // Update group tasks (move to top on update for group chats)
      setGroupTasks(prev => updateTaskInList(prev, true))

      // Update personal tasks (in place)
      setPersonalTasks(prev => updateTaskInList(prev, false))

      // Update combined tasks list
      setTasks(prev => {
        const taskIndex = prev.findIndex(task => task.id === data.task_id)
        if (taskIndex === -1) {
          return prev
        }

        const existingTask = prev[taskIndex]
        const isGroupChatTask = existingTask.is_group_chat === true

        // Update task status, progress, and completed_at for terminal states
        const updatedTask = {
          ...existingTask,
          status: data.status as TaskStatus,
          progress: data.progress ?? existingTask.progress,
          updated_at: now,
          // Update completed_at for terminal states
          ...(completedAt && { completed_at: completedAt }),
        }

        // For group chat tasks, move the task to the top of the list
        // This ensures new messages in group chats are visible
        if (isGroupChatTask) {
          const updatedTasks = [...prev]
          updatedTasks.splice(taskIndex, 1) // Remove from current position
          updatedTasks.unshift(updatedTask) // Add to the beginning

          // Schedule the side effects for after state update
          // For group chat tasks, trigger re-render to show unread indicator
          // Only if user is not currently viewing this task
          setTimeout(() => {
            if (!selectedTask || selectedTask.id !== data.task_id) {
              setViewStatusVersion(v => v + 1)
            }
          }, 0)

          return updatedTasks
        }

        // For non-group chat tasks, update in place
        const updatedTasks = [...prev]
        updatedTasks[taskIndex] = updatedTask

        // Schedule the side effects for after state update
        // For non-group-chat tasks reaching terminal state, update viewedAt
        if (isTerminalState && completedAt) {
          setTimeout(() => {
            const existingViewStatus = getTaskViewStatus(data.task_id)
            if (existingViewStatus) {
              // User has previously viewed this task, update viewedAt to match completed_at
              markTaskAsViewed(data.task_id, data.status as TaskStatus, completedAt)
              setViewStatusVersion(v => v + 1)
            }
          }, 0)
        }

        return updatedTasks
      })

      // Also update selected task detail if it's the same task
      if (selectedTask && selectedTask.id === data.task_id) {
        setSelectedTaskDetail(prev => {
          if (!prev) return prev
          return {
            ...prev,
            status: data.status as TaskStatus,
            progress: data.progress ?? prev.progress,
            updated_at: now,
            // Update completed_at for terminal states
            ...(completedAt && { completed_at: completedAt }),
          }
        })
      }
    },
    [selectedTask]
  )

  // Handle task app update via WebSocket (sent to task room when expose_service updates app data)
  const handleTaskAppUpdate = useCallback(
    (data: TaskAppUpdatePayload) => {
      console.log('[TaskContext] Received task:app_update', data)
      // Only update if this is the currently selected task
      if (selectedTask && selectedTask.id === data.task_id) {
        setSelectedTaskDetail(prev => {
          if (!prev) return prev
          return {
            ...prev,
            app: data.app,
          }
        })
      }
    },
    [selectedTask]
  )

  // Register WebSocket event handlers for real-time task updates
  useEffect(() => {
    // Only register handlers when WebSocket is connected
    if (!isConnected) {
      return
    }

    const cleanup = registerTaskHandlers({
      onTaskCreated: handleTaskCreated,
      onTaskInvited: handleTaskInvited,
      onTaskStatus: handleTaskStatus,
      onTaskAppUpdate: handleTaskAppUpdate,
    })

    return () => {
      cleanup()
    }
  }, [
    isConnected,
    registerTaskHandlers,
    handleTaskCreated,
    handleTaskInvited,
    handleTaskStatus,
    handleTaskAppUpdate,
  ])

  // Removed polling - relying entirely on WebSocket real-time updates
  // Task list will be updated via WebSocket events:
  // - task:created - new task created
  // - task:invited - user invited to group chat
  // - task:status - task status/progress updates

  const refreshSelectedTaskDetail = async (isAutoRefresh: boolean = false) => {
    if (!selectedTask) return

    // Only check task status during auto-refresh; manual trigger allows viewing completed tasks
    if (
      isAutoRefresh &&
      selectedTaskDetail &&
      (selectedTaskDetail.status === 'COMPLETED' ||
        selectedTaskDetail.status === 'FAILED' ||
        selectedTaskDetail.status === 'CANCELLED' ||
        selectedTaskDetail.status === 'DELETE')
    ) {
      return
    }

    try {
      // Clear access denied state before fetching
      setAccessDenied(false)
      const updatedTaskDetail = await taskApis.getTaskDetail(selectedTask.id)

      // Extract workbench data from subtasks
      let workbenchData = null
      if (Array.isArray(updatedTaskDetail.subtasks) && updatedTaskDetail.subtasks.length > 0) {
        for (const sub of updatedTaskDetail.subtasks) {
          const result = sub.result
          if (result && typeof result === 'object') {
            if (result.workbench) {
              workbenchData = result.workbench
            } else if (result.value && typeof result.value === 'object' && result.value.workbench) {
              workbenchData = result.value.workbench
            } else if (typeof result.value === 'string') {
              try {
                const parsedValue = JSON.parse(result.value)
                if (parsedValue.workbench) {
                  workbenchData = parsedValue.workbench
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
      }

      setSelectedTaskDetail(taskDetailWithWorkbench)
    } catch (error) {
      // Check if it's a 403 Forbidden or 404 Not Found error (access denied or task not found)
      // Both cases should show the access denied UI to prevent information leakage
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        setAccessDenied(true)
        setSelectedTaskDetail(null)
        return
      }
      console.error('Failed to refresh selected task detail:', error)
    }
  }

  // Trigger task detail refresh and manage WebSocket room when selectedTask changes
  // NOTE: joinTask is called here, and SocketContext's joinTask already has deduplication logic
  // (joinedTasksRef.current.has(taskId) check), so multiple calls are safe but wasteful.
  // We only call joinTask when isConnected is true to avoid unnecessary calls.
  useEffect(() => {
    const currentTaskId = selectedTask?.id ?? null
    const previousTaskId = previousTaskIdRef.current

    // Leave previous task room if switching to a different task
    if (previousTaskId !== null && previousTaskId !== currentTaskId) {
      leaveTask(previousTaskId)
    }

    // Update the ref to track current task
    previousTaskIdRef.current = currentTaskId

    if (selectedTask) {
      // Only join task room when WebSocket is connected
      // This prevents duplicate joins when both selectedTask and isConnected change
      if (isConnected) {
        console.log(
          '[TaskContext] joinTask called from selectedTask useEffect, taskId:',
          selectedTask.id
        )
        joinTask(selectedTask.id)
      }

      refreshSelectedTaskDetail(false) // Manual task selection, not auto-refresh
    } else {
      setSelectedTaskDetail(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask, leaveTask, joinTask, isConnected])

  // NOTE: Removed separate isConnected useEffect to prevent duplicate joinTask calls.
  // The selectedTask useEffect above now handles both cases:
  // 1. When selectedTask changes (and isConnected is true)
  // 2. When isConnected changes (and selectedTask is set)
  // This is because we added isConnected to the dependency array.

  // Mark task as viewed when selectedTaskDetail is loaded
  // This ensures we have the correct status and timestamps from the backend
  useEffect(() => {
    if (selectedTaskDetail) {
      const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED']
      // For terminal states, use task's completed_at/updated_at to ensure viewedAt >= taskUpdatedAt
      // This prevents the "unread" badge from showing due to client/server time differences
      const taskTimestamp = terminalStates.includes(selectedTaskDetail.status)
        ? selectedTaskDetail.completed_at ||
          selectedTaskDetail.updated_at ||
          new Date().toISOString()
        : undefined

      markTaskAsViewed(selectedTaskDetail.id, selectedTaskDetail.status, taskTimestamp)
      // Trigger re-render to update unread status in sidebar
      setViewStatusVersion(prev => prev + 1)
    }
  }, [
    selectedTaskDetail?.status,
    selectedTaskDetail?.id,
    selectedTaskDetail?.completed_at,
    selectedTaskDetail?.updated_at,
  ])

  // Search tasks
  const searchTasks = async (term: string) => {
    if (!term.trim()) {
      setIsSearchResult(false)
      return refreshTasks()
    }

    setIsSearching(true)
    setIsSearchResult(true)

    try {
      const result = await taskApis.searchTasks(term, { page: 1, limit: 100 })
      setTasks(result.items)
      setHasMore(false) // Search results do not support loading more pages
    } catch (error) {
      console.error('Failed to search tasks:', error)
    } finally {
      setIsSearching(false)
    }
  }

  // Handle marking all tasks as viewed
  const handleMarkAllTasksAsViewed = () => {
    markAllTasksAsViewed(tasks)
    // Trigger re-render by updating version
    setViewStatusVersion(prev => prev + 1)
  }

  // Wrapper for markTaskAsViewed that also triggers re-render
  // This ensures the unread dot disappears immediately when a task is clicked
  const handleMarkTaskAsViewed = useCallback(
    (taskId: number, status: TaskStatus, taskTimestamp?: string) => {
      markTaskAsViewed(taskId, status, taskTimestamp)
      // Trigger re-render to update unread status in sidebar
      setViewStatusVersion(prev => prev + 1)
    },
    []
  )

  // Clear access denied state (called when navigating away or starting new task)
  const clearAccessDenied = useCallback(() => {
    setAccessDenied(false)
  }, [])

  return (
    <TaskContext.Provider
      value={{
        tasks,
        groupTasks,
        personalTasks,
        taskLoading,
        selectedTask,
        selectedTaskDetail,
        setSelectedTask,
        refreshTasks,
        refreshGroupTasks,
        refreshPersonalTasks,
        refreshSelectedTaskDetail,
        loadMore,
        loadMoreGroupTasks,
        loadMorePersonalTasks,
        hasMore,
        hasMoreGroupTasks,
        hasMorePersonalTasks,
        loadingMore,
        loadingMoreGroupTasks,
        loadingMorePersonalTasks,
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
        isRefreshing,
      }}
    >
      {children}
    </TaskContext.Provider>
  )
}
/**
 * useTaskContext must be used within a TaskContextProvider.
 */
export const useTaskContext = () => {
  const context = useContext(TaskContext)
  if (!context) {
    throw new Error('useTaskContext must be used within a TaskContextProvider')
  }
  return context
}
