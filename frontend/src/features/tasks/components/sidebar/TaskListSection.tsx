// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Task, TaskType } from '@/types/api'
import TaskMenu from './TaskMenu'
import { TaskInlineRename } from '@/components/common/TaskInlineRename'
import {
  CheckCircle2,
  XCircle,
  StopCircle,
  PauseCircle,
  RotateCw,
  Code2,
  MessageSquare,
  Users,
  BookOpen,
} from 'lucide-react'

import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTranslation } from '@/hooks/useTranslation'
import { taskApis } from '@/apis/tasks'
import { isTaskUnread } from '@/utils/taskViewStatus'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDraggable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { useProjectContext } from '@/features/projects'

interface TaskListSectionProps {
  tasks: Task[]
  title: string
  unreadCount?: number
  onTaskClick?: () => void
  isCollapsed?: boolean
  showTitle?: boolean
  enableDrag?: boolean
}

import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'

// Draggable task item wrapper component
function DraggableTaskItem({
  task,
  children,
  enableDrag,
}: {
  task: Task
  children: React.ReactNode
  enableDrag: boolean
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: {
      type: 'task',
      task,
    },
    disabled: !enableDrag,
  })

  if (!enableDrag) {
    return <>{children}</>
  }

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'relative group/drag cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-50 ring-2 ring-primary ring-inset rounded-xl'
      )}
    >
      {children}
    </div>
  )
}

export default function TaskListSection({
  tasks,
  title,
  unreadCount = 0,
  onTaskClick,
  isCollapsed = false,
  showTitle = true,
  enableDrag = false,
}: TaskListSectionProps) {
  const router = useRouter()
  const {
    selectedTask,
    selectedTaskDetail,
    setSelectedTask,
    refreshTasks,
    viewStatusVersion,
    markTaskAsViewed,
  } = useTaskContext()
  const { clearAllStreams } = useChatStreamContext()
  const { t } = useTranslation()
  const { setSelectedProjectTaskId } = useProjectContext()
  // Use viewStatusVersion to trigger re-render when task view status changes
  // This is needed to update the unread dot immediately when a task is clicked
  const _viewStatusVersion = viewStatusVersion
  const [hoveredTaskId, setHoveredTaskId] = useState<number | null>(null)
  const [_loading, setLoading] = useState(false)
  const [longPressTaskId, setLongPressTaskId] = useState<number | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null)
  // Local task titles for optimistic update during rename
  const [localTitles, setLocalTitles] = useState<Record<number, string>>({})
  // Click timer ref for distinguishing single-click from double-click
  const clickTimerRef = useRef<NodeJS.Timeout | null>(null)
  const clickedTaskRef = useRef<Task | null>(null)

  // Touch interaction state
  const [touchState, setTouchState] = useState<{
    startX: number
    startY: number
    startTime: number
    taskId: number | null
    isScrolling: boolean
    longPressTimer: NodeJS.Timeout | null
  }>({
    startX: 0,
    startY: 0,
    startTime: 0,
    taskId: null,
    isScrolling: false,
    longPressTimer: null,
  })

  // Select task
  const handleTaskClick = (task: Task) => {
    // Clear all stream states when switching tasks to prevent auto-switching back
    // when the previous streaming task completes
    clearAllStreams()

    // Immediately mark task as viewed to clear the unread dot
    // Use current time as viewedAt to ensure it's always >= task's completed_at/updated_at
    // This is simpler and more reliable than using task timestamps which may vary
    // between list items and task details
    markTaskAsViewed(task.id, task.status)

    // Clear project section selection to remove highlight from project area
    setSelectedProjectTaskId(null)

    // IMPORTANT: Set selected task immediately to prevent visual flicker
    // This ensures the task is highlighted before navigation completes
    setSelectedTask(task)

    if (typeof window !== 'undefined') {
      const params = new URLSearchParams()
      params.set('taskId', String(task.id))

      // Navigate to the appropriate page based on task task_type
      // If task_type is not set, infer from git information
      let targetPath = paths.chat.getHref() // default to chat

      if (task.task_type === 'knowledge' && task.knowledge_base_id) {
        // Knowledge type tasks navigate to the knowledge base page
        targetPath = `/knowledge/document/${task.knowledge_base_id}`
      } else if (task.task_type === 'code') {
        targetPath = paths.code.getHref()
      } else if (task.task_type === 'chat') {
        targetPath = paths.chat.getHref()
      } else {
        // For backward compatibility: infer type from git information
        // If task has git repo info, assume it's a code task
        if (task.git_repo && task.git_repo.trim() !== '') {
          targetPath = paths.code.getHref()
        } else {
          targetPath = paths.chat.getHref()
        }
      }

      router.push(`${targetPath}?${params.toString()}`)

      // Call the onTaskClick callback if provided (to close mobile sidebar)
      if (onTaskClick) {
        onTaskClick()
      }
    }
  }

  // Touch interaction handlers
  const handleTouchStart = (task: Task) => (event: React.TouchEvent) => {
    const touch = event.touches[0]
    const longPressTimer = setTimeout(() => {
      // Long press detected - show menu on mobile
      setLongPressTaskId(task.id)
      setTouchState(prev => ({ ...prev, isScrolling: true })) // Prevent click after long press
    }, 500)

    setTouchState({
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      taskId: task.id,
      isScrolling: false,
      longPressTimer,
    })
  }

  const handleTouchMove = (event: React.TouchEvent) => {
    if (!touchState.taskId) return

    const touch = event.touches[0]
    const deltaX = Math.abs(touch.clientX - touchState.startX)
    const deltaY = Math.abs(touch.clientY - touchState.startY)
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)

    // If moved more than 10px, consider it as scrolling
    if (distance > 10) {
      if (touchState.longPressTimer) {
        clearTimeout(touchState.longPressTimer)
      }
      setTouchState(prev => ({ ...prev, isScrolling: true, longPressTimer: null }))
    }
  }

  const handleTouchEnd = (task: Task) => (_event: React.TouchEvent) => {
    if (touchState.longPressTimer) {
      clearTimeout(touchState.longPressTimer)
    }

    const touchDuration = Date.now() - touchState.startTime

    // Only trigger click if:
    // 1. Not scrolling
    // 2. Touch duration < 500ms (not a long press)
    // 3. Touch is on the same task
    if (!touchState.isScrolling && touchDuration < 500 && touchState.taskId === task.id) {
      handleTaskClick(task)
    }

    setTouchState({
      startX: 0,
      startY: 0,
      startTime: 0,
      taskId: null,
      isScrolling: false,
      longPressTimer: null,
    })
  }

  // Cleanup effect for touch state
  useEffect(() => {
    return () => {
      if (touchState.longPressTimer) {
        clearTimeout(touchState.longPressTimer)
      }
    }
  }, [touchState.longPressTimer])

  // Cleanup effect for click timer
  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
      }
    }
  }, [])

  // Handle clicks outside to close long press menu
  useEffect(() => {
    const handleClickOutside = () => {
      if (longPressTaskId !== null) {
        setLongPressTaskId(null)
      }
    }

    if (longPressTaskId !== null) {
      document.addEventListener('click', handleClickOutside)
      return () => {
        document.removeEventListener('click', handleClickOutside)
      }
    }
  }, [longPressTaskId])

  // Copy task ID
  const handleCopyTaskId = async (taskId: number) => {
    const textToCopy = taskId.toString()
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(textToCopy)
        return
      } catch (err) {
        console.error('Copy failed', err)
      }
    }
    try {
      const textarea = document.createElement('textarea')
      textarea.value = textToCopy
      textarea.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    } catch (err) {
      console.error('Fallback copy failed', err)
    }
  }

  // Delete task
  const handleDeleteTask = async (taskId: number) => {
    setLoading(true)
    try {
      await taskApis.deleteTask(taskId)
      setSelectedTask(null)
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.delete('taskId')
        router.replace(url.pathname + url.search)
        refreshTasks()
      }
    } catch (err) {
      console.error('Delete failed', err)
    } finally {
      setLoading(false)
    }
  }

  // Start inline editing for a task
  const handleStartRename = useCallback((taskId: number) => {
    setEditingTaskId(taskId)
    setLongPressTaskId(null) // Close long press menu
  }, [])

  // Save renamed task
  const handleSaveRename = useCallback(
    async (taskId: number, newTitle: string) => {
      // Call API to update task title
      await taskApis.updateTask(taskId, { title: newTitle })
      // Optimistic update: update local state immediately
      setLocalTitles(prev => ({ ...prev, [taskId]: newTitle }))
      // Refresh tasks to sync with server
      refreshTasks()
    },
    [refreshTasks]
  )

  // Cancel rename
  const handleCancelRename = useCallback(() => {
    setEditingTaskId(null)
  }, [])

  if (tasks.length === 0) return null

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />
      case 'FAILED':
        return <XCircle className="w-4 h-4 text-red-500" />
      case 'CANCELLED':
        return <StopCircle className="w-4 h-4 text-gray-400" />
      case 'RUNNING':
        return (
          <RotateCw
            className="w-4 h-4 text-blue-500 animate-spin"
            style={{ animationDuration: '2s' }}
          />
        )
      case 'PENDING':
        return <PauseCircle className="w-4 h-4 text-yellow-500" />
      default:
        return <PauseCircle className="w-4 h-4 text-gray-400" />
    }
  }

  const formatTimeAgo = (dateString: string) => {
    const now = new Date()
    const date = new Date(dateString)
    const diffMs = now.getTime() - date.getTime()

    const MINUTE_MS = 60 * 1000
    const HOUR_MS = 60 * MINUTE_MS
    const DAY_MS = 24 * HOUR_MS

    // Handle negative time difference (client time earlier than server time)
    // or very small positive differences (< 1 minute)
    if (diffMs < MINUTE_MS) {
      return '0m'
    } else if (diffMs < HOUR_MS) {
      return `${Math.floor(diffMs / MINUTE_MS)}m`
    } else if (diffMs < DAY_MS) {
      return `${Math.floor(diffMs / HOUR_MS)}h`
    } else {
      return `${Math.floor(diffMs / DAY_MS)}d`
    }
  }

  const getUnreadDotColor = (task: Task) => {
    // For group chat tasks, always use green to indicate new messages
    if (task.is_group_chat) {
      return 'bg-green-500'
    }
    // For non-group-chat tasks, use status-based colors
    switch (task.status) {
      case 'COMPLETED':
        return 'bg-green-500'
      case 'FAILED':
        return 'bg-red-500'
      case 'CANCELLED':
        return 'bg-gray-400'
      default:
        return 'bg-gray-400'
    }
  }

  // Determine whether to show status icon in expanded mode
  // Terminal states only show icon when unread, non-terminal states always show
  // Group chat tasks show icon when there are unread messages
  const shouldShowStatusIcon = (task: Task): boolean => {
    // For group chat tasks, show icon when there are unread messages
    if (task.is_group_chat) {
      return isTaskUnread(task)
    }
    const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED']
    if (terminalStates.includes(task.status)) {
      const unread = isTaskUnread(task)
      return unread
    }
    return true
  }

  const getTaskTypeIcon = (task: Task) => {
    let taskType: TaskType | undefined = task.task_type
    if (!taskType) {
      if (task.git_repo && task.git_repo.trim() !== '') {
        taskType = 'code'
      } else {
        taskType = 'chat'
      }
    }

    // Show group chat icon for group chats
    if (task.is_group_chat) {
      return <Users className="w-3.5 h-3.5 text-text-primary" />
    }

    if (taskType === 'knowledge') {
      return <BookOpen className="w-3.5 h-3.5 text-text-primary" />
    } else if (taskType === 'code') {
      return <Code2 className="w-3.5 h-3.5 text-text-primary" />
    } else {
      return <MessageSquare className="w-3.5 h-3.5 text-text-primary" />
    }
  }

  return (
    <div className={`mb-2 w-full ${isCollapsed ? 'px-2' : ''}`}>
      {/* Section title with divider in collapsed mode */}
      {isCollapsed
        ? showTitle && <div className="border-t border-border my-2" />
        : showTitle &&
          title && (
            <h3 className="text-sm text-text-primary tracking-wide mb-1 px-2">
              {title}
              {unreadCount > 0 && <span className="text-primary ml-1">({unreadCount})</span>}
            </h3>
          )}
      <div className="space-y-0.5">
        {tasks.map(task => {
          const showMenu = hoveredTaskId === task.id || longPressTaskId === task.id

          // Collapsed mode: Show only status icon with tooltip
          if (isCollapsed) {
            const taskTypeLabel = (() => {
              let taskType: TaskType | undefined = task.task_type
              if (!taskType) {
                if (task.git_repo && task.git_repo.trim() !== '') {
                  taskType = 'code'
                } else {
                  taskType = 'chat'
                }
              }
              if (taskType === 'knowledge') {
                return t('common:navigation.wiki')
              }
              return taskType === 'code' ? t('common:navigation.code') : t('common:navigation.chat')
            })()

            const truncatedTitle =
              task.title.length > 30 ? task.title.slice(0, 30) + '...' : task.title

            return (
              <TooltipProvider key={task.id}>
                <Tooltip delayDuration={0}>
                  <TooltipTrigger asChild>
                    <div
                      className={`flex items-center justify-center py-1.5 px-2 h-8 rounded-xl cursor-pointer ${
                        selectedTask?.id === task.id || selectedTaskDetail?.id === task.id
                          ? 'bg-primary/10'
                          : 'hover:bg-hover'
                      }`}
                      onClick={() => handleTaskClick(task)}
                    >
                      <div className="relative flex items-center justify-center">
                        <div className="w-4 h-4 flex items-center justify-center">
                          {getStatusIcon(task.status)}
                        </div>
                        {isTaskUnread(task) && (
                          <span
                            className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${getUnreadDotColor(task)} animate-pulse-dot`}
                          />
                        )}
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-xs">
                    <p className="font-medium">{truncatedTitle}</p>
                    <p className="text-xs text-text-muted">
                      {taskTypeLabel} · {formatTimeAgo(task.created_at)}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )
          }

          // Expanded mode: Show full task item with tooltip
          const taskTypeLabel = (() => {
            let taskType: TaskType | undefined = task.task_type
            if (!taskType) {
              if (task.git_repo && task.git_repo.trim() !== '') {
                taskType = 'code'
              } else {
                taskType = 'chat'
              }
            }
            if (taskType === 'knowledge') {
              return t('common:navigation.wiki')
            }
            return taskType === 'code' ? t('common:navigation.code') : t('common:navigation.chat')
          })()

          return (
            <DraggableTaskItem key={task.id} task={task} enableDrag={enableDrag}>
              <TooltipProvider>
                <Tooltip delayDuration={500}>
                  <TooltipTrigger asChild>
                    <div
                      className={`flex items-center gap-2 py-1.5 px-3 rounded-xl cursor-pointer ${
                        editingTaskId === task.id ? 'h-12' : 'h-8'
                      } ${
                        selectedTask?.id === task.id || selectedTaskDetail?.id === task.id
                          ? 'bg-primary/10'
                          : 'hover:bg-hover'
                      }`}
                      onClick={() => {
                        // Don't trigger task click when editing
                        if (editingTaskId === task.id) return

                        // Use delayed single-click to distinguish from double-click
                        // If a click timer already exists, this is a double-click
                        if (clickTimerRef.current && clickedTaskRef.current?.id === task.id) {
                          // Double-click detected - cancel the single click and start rename
                          clearTimeout(clickTimerRef.current)
                          clickTimerRef.current = null
                          clickedTaskRef.current = null
                          handleStartRename(task.id)
                        } else {
                          // First click - set timer for delayed navigation
                          // If no second click within 250ms, execute single-click action
                          clickedTaskRef.current = task
                          clickTimerRef.current = setTimeout(() => {
                            clickTimerRef.current = null
                            clickedTaskRef.current = null
                            handleTaskClick(task)
                          }, 250)
                        }
                      }}
                      onTouchStart={handleTouchStart(task)}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleTouchEnd(task)}
                      onMouseEnter={() => setHoveredTaskId(task.id)}
                      onMouseLeave={() => setHoveredTaskId(null)}
                      style={{
                        touchAction: 'pan-y',
                        WebkitTapHighlightColor: 'transparent',
                        userSelect: 'none',
                      }}
                    >
                      {/* Task type icon on the left */}
                      <div className="flex-shrink-0">{getTaskTypeIcon(task)}</div>

                      {/* Task title in the middle - supports inline editing */}
                      {editingTaskId === task.id ? (
                        <TaskInlineRename
                          taskId={task.id}
                          initialTitle={localTitles[task.id] ?? task.title}
                          isEditing={true}
                          onEditEnd={handleCancelRename}
                          onSave={async (newTitle: string) => {
                            await handleSaveRename(task.id, newTitle)
                          }}
                        />
                      ) : (
                        <span className="flex-1 min-w-0 text-sm text-text-primary leading-tight truncate">
                          {localTitles[task.id] ?? task.title}
                        </span>
                      )}

                      {/* Status icon on the right - only render container when needed */}
                      {(shouldShowStatusIcon(task) || isTaskUnread(task)) &&
                        editingTaskId !== task.id && (
                          <div className="flex-shrink-0 relative">
                            <div className="w-4 h-4 flex items-center justify-center">
                              {shouldShowStatusIcon(task) && getStatusIcon(task.status)}
                            </div>
                            {isTaskUnread(task) && (
                              <span
                                className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${getUnreadDotColor(task)} animate-pulse-dot`}
                              />
                            )}
                          </div>
                        )}

                      {editingTaskId !== task.id && (
                        <div className="flex-shrink-0">
                          <div
                            className={`transition-opacity duration-150 [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto ${
                              showMenu ? 'opacity-100' : 'opacity-0 pointer-events-none'
                            }`}
                            onTouchStart={e => e.stopPropagation()}
                            onTouchEnd={e => e.stopPropagation()}
                            onClick={e => e.stopPropagation()}
                          >
                            <TaskMenu
                              taskId={task.id}
                              handleCopyTaskId={handleCopyTaskId}
                              handleDeleteTask={handleDeleteTask}
                              onRename={() => handleStartRename(task.id)}
                              isGroupChat={task.is_group_chat}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-xs">
                    <p className="font-medium">{localTitles[task.id] ?? task.title}</p>
                    <p className="text-xs text-text-muted">
                      {taskTypeLabel} · {formatTimeAgo(task.created_at)}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </DraggableTaskItem>
          )
        })}
      </div>
    </div>
  )
}
