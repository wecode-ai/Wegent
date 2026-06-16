// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Task, TaskDetail, TaskRuntimeCheck, TaskStatus } from '@/types/api'
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
import { PROJECT_DELETED_EVENT } from '@/features/projects/events'

export type TaskPuller = {
  tasks: Task[]
  groupTasks: Task[]
  personalTasks: Task[]
  taskLoading: boolean
  selectedTask: Task | null
  selectedTaskDetail: TaskDetail | null
  taskRuntimeSnapshot: TaskRuntimeCheck | null
  writeSelectedTask: (task: Task | null) => void
  resetSelectedTaskState: () => void
  prepareSelectedTaskState: (task: Task) => void
  pullTaskDetail: (taskId: number) => Promise<TaskDetail | null>
  pullRuntime: (taskId?: number) => Promise<TaskRuntimeCheck | null>
  refreshTasks: () => void
  refreshGroupTasks: () => void
  refreshPersonalTasks: () => void
  refreshSelectedTaskDetail: () => Promise<void>
  verifyTaskRuntime: (taskId?: number) => Promise<TaskRuntimeCheck | null>
  loadMore: () => void
  loadAllGroupTasks: () => Promise<void>
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
  // Refreshing state for runtime snapshot checks
  isRefreshing: boolean
}

export function useTaskPuller(): TaskPuller {
  const [tasks, setTasks] = useState<Task[]>([])
  const [groupTasks, setGroupTasks] = useState<Task[]>([])
  const [personalTasks, setPersonalTasks] = useState<Task[]>([])
  const [taskLoading, setTaskLoading] = useState<boolean>(false)
  const [selectedTask, setSelectedTaskState] = useState<Task | null>(null)
  const [selectedTaskDetail, setSelectedTaskDetail] = useState<TaskDetail | null>(null)
  const [taskRuntimeSnapshot, setTaskRuntimeSnapshot] = useState<TaskRuntimeCheck | null>(null)
  const [searchTerm, setSearchTerm] = useState<string>('')
  const [isSearching, setIsSearching] = useState<boolean>(false)
  const [isSearchResult, setIsSearchResult] = useState<boolean>(false)
  const [viewStatusVersion, setViewStatusVersion] = useState<number>(0)
  // Access denied state for 403 errors when accessing shared tasks
  const [accessDenied, setAccessDenied] = useState<boolean>(false)
  // Refreshing state for runtime snapshot checks.
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false)

  // Track task status for notification
  const taskStatusMapRef = useRef<Map<number, TaskStatus>>(new Map())
  const selectedTaskRef = useRef<Task | null>(null)
  const selectionEpochRef = useRef(0)
  const refreshTasksRef = useRef<(() => void) | null>(null)

  const isCurrentSelection = useCallback((taskId: number, epoch: number): boolean => {
    return selectionEpochRef.current === epoch && selectedTaskRef.current?.id === taskId
  }, [])

  const writeSelectedTask = useCallback((task: Task | null) => {
    const previousTaskId = selectedTaskRef.current?.id ?? null
    const nextTaskId = task?.id ?? null
    if (previousTaskId !== nextTaskId) {
      selectionEpochRef.current += 1
    }
    selectedTaskRef.current = task
    setSelectedTaskState(task)
  }, [])

  // WebSocket connection for real-time task updates
  const { registerTaskHandlers, isConnected } = useSocket()

  // Pagination related - combined task list
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadedPages, setLoadedPages] = useState([1])
  const limit = 50

  // Pagination related - group tasks
  const [hasMoreGroupTasks, setHasMoreGroupTasks] = useState(true)
  const [loadingMoreGroupTasks, setLoadingMoreGroupTasks] = useState(false)
  const [loadedGroupPages, setLoadedGroupPages] = useState<number[]>([])

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
      console.error('[taskPuller] Failed to load pages:', err)
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
      console.error('[taskPuller] Failed to load group pages:', err)
      return { items: [], hasMore: true, pages: pagesArr, error: true }
    }
  }

  // Load personal task pages
  const loadPersonalPages = async (pagesArr: number[]) => {
    if (pagesArr.length === 0) return { items: [], hasMore: false, error: false }
    try {
      const requests = pagesArr.map(p => taskApis.getPersonalTasksLite({ page: p, limit }))
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
      console.error('[taskPuller] Failed to load personal pages:', err)
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
    const nextPage = (loadedGroupPages[loadedGroupPages.length - 1] || 0) + 1
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

  // Load every remaining group task page.
  const loadAllGroupTasks = async () => {
    if (loadingMoreGroupTasks || !hasMoreGroupTasks) return

    setLoadingMoreGroupTasks(true)
    const loadedItems: Task[] = []
    const loadedPagesToAdd: number[] = []
    let nextPage = loadedGroupPages.length > 0 ? Math.max(...loadedGroupPages) + 1 : 1
    let reachedEnd = false
    let hasError = false

    while (!reachedEnd && !hasError) {
      const result = await loadGroupPages([nextPage])

      if (result.error) {
        hasError = true
        break
      }

      loadedItems.push(...result.items)
      loadedPagesToAdd.push(...(result.pages || [nextPage]))
      reachedEnd = !result.hasMore
      nextPage += 1
    }

    if (loadedItems.length > 0 || loadedPagesToAdd.length > 0) {
      setGroupTasks(prev => {
        const existingIds = new Set(prev.map(t => t.id))
        const newItems = loadedItems.filter(t => !existingIds.has(t.id))
        return [...prev, ...newItems]
      })
      setLoadedGroupPages(prev =>
        Array.from(new Set([...prev, ...loadedPagesToAdd])).sort((a, b) => a - b)
      )
    }

    if (!hasError) {
      setHasMoreGroupTasks(false)
    }
    setLoadingMoreGroupTasks(false)
  }

  // Load more personal tasks
  const loadMorePersonalTasks = async () => {
    if (loadingMorePersonalTasks || !hasMorePersonalTasks) return
    setLoadingMorePersonalTasks(true)
    let nextPage = (loadedPersonalPages[loadedPersonalPages.length - 1] || 1) + 1
    let reachedEnd = false
    let hasError = false
    const loadedPagesToAdd: number[] = []
    const loadedItems: Task[] = []
    const existingIds = new Set(personalTasks.map(task => task.id))

    while (!reachedEnd && !hasError && loadedItems.length === 0) {
      const result = await loadPersonalPages([nextPage])

      if (result.error) {
        hasError = true
        break
      }

      loadedPagesToAdd.push(...(result.pages || [nextPage]))
      const newItems = result.items.filter(task => !existingIds.has(task.id))
      newItems.forEach(task => existingIds.add(task.id))

      if (newItems.length > 0) {
        loadedItems.push(...newItems)
      }

      reachedEnd = !result.hasMore
      nextPage += 1
    }

    if (!hasError) {
      setPersonalTasks(prev => {
        const existingIds = new Set(prev.map(t => t.id))
        const newItems = loadedItems.filter(t => !existingIds.has(t.id))
        return [...prev, ...newItems]
      })
      setLoadedPersonalPages(prev =>
        Array.from(new Set([...prev, ...loadedPagesToAdd])).sort((a, b) => a - b)
      )
      setHasMorePersonalTasks(!reachedEnd)
    }
    setLoadingMorePersonalTasks(false)
  }

  // Refresh all loaded pages
  const refreshTasks = async () => {
    setTaskLoading(true)

    const shouldRefreshGroupTasks = loadedGroupPages.length > 0
    const [groupResult, personalResult] = await Promise.all([
      shouldRefreshGroupTasks
        ? loadGroupPages(loadedGroupPages)
        : Promise.resolve({
            items: groupTasks,
            hasMore: hasMoreGroupTasks,
            pages: loadedGroupPages,
            error: false,
          }),
      loadPersonalPages(loadedPersonalPages),
    ])

    // Update group tasks
    if (shouldRefreshGroupTasks && !groupResult.error) {
      setGroupTasks(groupResult.items)
      setLoadedGroupPages(groupResult.pages || [])
      setHasMoreGroupTasks(groupResult.hasMore)
    }

    // Update personal tasks
    if (!personalResult.error) {
      setPersonalTasks(personalResult.items)
      setLoadedPersonalPages(personalResult.pages || [1])
      setHasMorePersonalTasks(personalResult.hasMore)
    }

    // Combine both lists for the combined task list
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

  refreshTasksRef.current = refreshTasks

  useEffect(() => {
    const handleProjectDeleted = () => {
      refreshTasksRef.current?.()
    }

    window.addEventListener(PROJECT_DELETED_EVENT, handleProjectDeleted)
    return () => window.removeEventListener(PROJECT_DELETED_EVENT, handleProjectDeleted)
  }, [])

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
      team_name: data.team_name,
      team_namespace: 'default',
      team_display_name: data.team_name,
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

    // Also update combined tasks list for the combined task list
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
      team_name: data.team_name,
      team_namespace: 'default',
      team_display_name: data.team_name,
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

    // Also update combined tasks list for the combined task list
    setTasks(prev => {
      const exists = prev.some(task => task.id === data.task_id)
      if (exists) return prev
      return [newTask, ...prev]
    })
  }, [])

  // Handle task status update via WebSocket
  const handleTaskStatus = useCallback(
    (data: TaskStatusPayload) => {
      const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED']
      const isTerminalState = terminalStates.includes(data.status)
      const statusUpdatedAt = data.updated_at
      const completedAt = isTerminalState ? data.completed_at || statusUpdatedAt : undefined

      // Helper function to update a task in a list
      const updateTaskInList = (prev: Task[], moveToTop = false) => {
        const taskIndex = prev.findIndex(task => task.id === data.task_id)
        if (taskIndex === -1) return prev

        const existingTask = prev[taskIndex]
        const updatedTask = {
          ...existingTask,
          status: data.status as TaskStatus,
          progress: data.progress ?? existingTask.progress,
          updated_at: statusUpdatedAt ?? completedAt ?? existingTask.updated_at,
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
          updated_at: statusUpdatedAt ?? completedAt ?? existingTask.updated_at,
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
        setTaskRuntimeSnapshot(prev =>
          prev && prev.task_id === data.task_id
            ? {
                ...prev,
                task_status: data.status as TaskStatus,
                status_updated_at: statusUpdatedAt || completedAt || prev.status_updated_at,
                active_stream: isTerminalState ? null : prev.active_stream,
              }
            : prev
        )
        setSelectedTaskDetail(prev => {
          if (!prev) return prev
          return {
            ...prev,
            status: data.status as TaskStatus,
            progress: data.progress ?? prev.progress,
            updated_at: statusUpdatedAt ?? completedAt ?? prev.updated_at,
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

  // Task lists are updated by WebSocket events and refreshed after runtime health checks.

  const pullTaskDetail = useCallback(
    async (taskId: number): Promise<TaskDetail | null> => {
      const requestEpoch = selectionEpochRef.current

      try {
        if (isCurrentSelection(taskId, requestEpoch)) {
          setAccessDenied(false)
        }

        const updatedTaskDetail = await taskApis.getTaskDetail(taskId)
        if (!isCurrentSelection(taskId, requestEpoch)) return null

        setSelectedTaskDetail(updatedTaskDetail)
        return updatedTaskDetail
      } catch (error) {
        if (!isCurrentSelection(taskId, requestEpoch)) return null

        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          setAccessDenied(true)
          setSelectedTaskDetail(null)
          return null
        }
        console.error('[taskPuller] Failed to pull task detail:', error)
        return null
      }
    },
    [isCurrentSelection]
  )

  const refreshSelectedTaskDetail = async () => {
    if (!selectedTask) return

    await pullTaskDetail(selectedTask.id)
  }

  const pullRuntime = useCallback(
    async (taskId?: number): Promise<TaskRuntimeCheck | null> => {
      const targetTaskId = taskId ?? selectedTaskRef.current?.id
      if (!targetTaskId) return null
      const requestEpoch = selectionEpochRef.current
      if (!isCurrentSelection(targetTaskId, requestEpoch)) return null

      setIsRefreshing(true)
      try {
        const snapshot = await taskApis.getTaskRuntimeCheck(targetTaskId)
        if (!isCurrentSelection(targetTaskId, requestEpoch)) return null

        setTaskRuntimeSnapshot(snapshot)

        setSelectedTaskDetail(prev => {
          if (!prev || prev.id !== snapshot.task_id) return prev
          return {
            ...prev,
            status: snapshot.task_status,
            updated_at: snapshot.status_updated_at || prev.updated_at,
            ...(snapshot.active_stream ? {} : { progress: prev.progress }),
          }
        })

        return snapshot
      } catch (error) {
        if (!isCurrentSelection(targetTaskId, requestEpoch)) return null
        console.error('[taskPuller] Failed to verify task runtime:', error)
        return null
      } finally {
        if (isCurrentSelection(targetTaskId, requestEpoch)) {
          setIsRefreshing(false)
        }
      }
    },
    [isCurrentSelection]
  )

  const verifyTaskRuntime = pullRuntime

  const clearSelectedTaskArtifacts = useCallback(() => {
    setTaskRuntimeSnapshot(null)
    setSelectedTaskDetail(null)
    setAccessDenied(false)
    setIsRefreshing(false)
  }, [])

  const resetSelectedTaskState = useCallback(() => {
    writeSelectedTask(null)
    clearSelectedTaskArtifacts()
  }, [clearSelectedTaskArtifacts, writeSelectedTask])

  const prepareSelectedTaskState = useCallback(
    (task: Task) => {
      writeSelectedTask(task)
      clearSelectedTaskArtifacts()
    },
    [clearSelectedTaskArtifacts, writeSelectedTask]
  )

  const selectedTaskDetailId = selectedTaskDetail?.id
  const selectedTaskDetailStatus = selectedTaskDetail?.status
  const selectedTaskDetailCompletedAt = selectedTaskDetail?.completed_at
  const selectedTaskDetailUpdatedAt = selectedTaskDetail?.updated_at

  // Mark task as viewed when selectedTaskDetail is loaded
  // This ensures we have the correct status and timestamps from the backend
  useEffect(() => {
    if (selectedTaskDetailId === undefined || !selectedTaskDetailStatus) return

    const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED']
    // For terminal states, use task's completed_at/updated_at to ensure viewedAt >= taskUpdatedAt
    // This prevents the "unread" badge from showing due to client/server time differences
    const taskTimestamp = terminalStates.includes(selectedTaskDetailStatus)
      ? selectedTaskDetailCompletedAt || selectedTaskDetailUpdatedAt || new Date().toISOString()
      : undefined

    markTaskAsViewed(selectedTaskDetailId, selectedTaskDetailStatus, taskTimestamp)
    // Trigger re-render to update unread status in sidebar
    setViewStatusVersion(prev => prev + 1)
  }, [
    selectedTaskDetailId,
    selectedTaskDetailStatus,
    selectedTaskDetailCompletedAt,
    selectedTaskDetailUpdatedAt,
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

  return {
    tasks,
    groupTasks,
    personalTasks,
    taskLoading,
    selectedTask,
    selectedTaskDetail,
    taskRuntimeSnapshot,
    writeSelectedTask,
    resetSelectedTaskState,
    prepareSelectedTaskState,
    pullTaskDetail,
    pullRuntime,
    refreshTasks,
    refreshGroupTasks,
    refreshPersonalTasks,
    refreshSelectedTaskDetail,
    verifyTaskRuntime,
    loadMore,
    loadAllGroupTasks,
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
  }
}
