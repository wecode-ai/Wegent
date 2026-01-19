// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  X,
  CheckCircle2,
  XCircle,
  StopCircle,
  PauseCircle,
  RotateCw,
  Code2,
  MessageSquare,
  Users,
  Trash2,
  Check,
  Square,
  CheckSquare,
  Workflow,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { Task } from '@/types/api'
import { paths } from '@/config/paths'
import { taskApis } from '@/apis/tasks'

// History filter type: online (chat), offline (code), flow
export type HistoryFilterType = 'online' | 'offline' | 'flow'

// LocalStorage key for filter preferences
const HISTORY_FILTER_KEY = 'wegent_history_filter_types'

// Get saved filter types from localStorage
const getSavedFilterTypes = (): HistoryFilterType[] => {
  if (typeof window === 'undefined') return ['online', 'offline']
  try {
    const saved = localStorage.getItem(HISTORY_FILTER_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter(
          (t: string) => t === 'online' || t === 'offline' || t === 'flow'
        ) as HistoryFilterType[]
      }
    }
  } catch (e) {
    console.error('Failed to parse saved history filter types:', e)
  }
  return ['online', 'offline']
}

// Save filter types to localStorage
const saveFilterTypes = (types: HistoryFilterType[]) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(HISTORY_FILTER_KEY, JSON.stringify(types))
  } catch (e) {
    console.error('Failed to save history filter types:', e)
  }
}

interface HistoryManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const PAGE_SIZE = 20

export default function HistoryManageDialog({ open, onOpenChange }: HistoryManageDialogProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const { setSelectedTask, refreshPersonalTasks } = useTaskContext()

  // Filter types state
  const [filterTypes, setFilterTypes] = useState<HistoryFilterType[]>(['online', 'offline'])

  // Selected tasks for batch delete
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set())

  // Is deleting
  const [isDeleting, setIsDeleting] = useState(false)

  // Pagination state - load data independently
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // Load saved filter types on mount
  useEffect(() => {
    setFilterTypes(getSavedFilterTypes())
  }, [])

  // Convert filter types to API types
  const getApiTypes = useCallback((filters: HistoryFilterType[]): string[] => {
    return filters
  }, [])

  // Load tasks when dialog opens
  const loadTasks = useCallback(
    async (page: number, append = false, types: HistoryFilterType[] = filterTypes) => {
      if (page === 1) {
        setIsLoading(true)
      } else {
        setIsLoadingMore(true)
      }

      try {
        const result = await taskApis.getPersonalTasksLite({
          page,
          limit: PAGE_SIZE,
          types: getApiTypes(types),
        })
        if (append) {
          setAllTasks(prev => [...prev, ...result.items])
        } else {
          setAllTasks(result.items)
        }
        setHasMore(result.items.length === PAGE_SIZE)
        setCurrentPage(page)
      } catch (error) {
        console.error('Failed to load tasks:', error)
      } finally {
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    },
    [filterTypes, getApiTypes]
  )

  // Load initial data when dialog opens
  useEffect(() => {
    if (open) {
      const savedTypes = getSavedFilterTypes()
      setFilterTypes(savedTypes)
      setCurrentPage(1)
      setAllTasks([])
      loadTasks(1, false, savedTypes)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load more handler
  const handleLoadMore = useCallback(() => {
    if (!isLoadingMore && hasMore) {
      loadTasks(currentPage + 1, true)
    }
  }, [currentPage, hasMore, isLoadingMore, loadTasks])

  // Save filter types when changed and reload
  const handleFilterChange = (type: HistoryFilterType) => {
    setFilterTypes(prev => {
      let newTypes: HistoryFilterType[]
      if (prev.includes(type)) {
        // Don't allow deselecting all
        if (prev.length === 1) return prev
        newTypes = prev.filter(t => t !== type)
      } else {
        newTypes = [...prev, type]
      }
      saveFilterTypes(newTypes)
      // Reload with new filter
      setCurrentPage(1)
      setAllTasks([])
      loadTasks(1, false, newTypes)
      return newTypes
    })
  }

  // Tasks are already filtered by API, just use them directly
  const filteredTasks = allTasks

  // Clear selection when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedTaskIds(new Set())
    }
  }, [open])

  // Toggle task selection
  const toggleTaskSelection = (taskId: number) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }

  // Select all
  const selectAll = () => {
    setSelectedTaskIds(new Set(filteredTasks.map(t => t.id)))
  }

  // Deselect all
  const deselectAll = () => {
    setSelectedTaskIds(new Set())
  }

  // Delete selected tasks
  const handleDeleteSelected = useCallback(async () => {
    if (selectedTaskIds.size === 0) return

    setIsDeleting(true)
    try {
      // Delete tasks one by one
      for (const taskId of selectedTaskIds) {
        await taskApis.deleteTask(taskId)
      }
      setSelectedTaskIds(new Set())
      // Reload the task list
      loadTasks(1, false)
      // Also refresh the sidebar
      refreshPersonalTasks()
    } catch (error) {
      console.error('Failed to delete tasks:', error)
    } finally {
      setIsDeleting(false)
    }
  }, [selectedTaskIds, loadTasks, refreshPersonalTasks])

  // Delete single task
  const handleDeleteSingleTask = useCallback(
    async (taskId: number) => {
      try {
        await taskApis.deleteTask(taskId)
        // Remove from local state
        setAllTasks(prev => prev.filter(t => t.id !== taskId))
        // Also refresh the sidebar
        refreshPersonalTasks()
      } catch (error) {
        console.error('Failed to delete task:', error)
      }
    },
    [refreshPersonalTasks]
  )

  // Handle task click (navigate to task)
  const handleTaskClick = (task: Task) => {
    onOpenChange(false)
    setSelectedTask(task)
    const targetPath = task.task_type === 'code' ? paths.code.getHref() : paths.chat.getHref()
    router.push(`${targetPath}?taskId=${task.id}`)
  }

  // Format time ago
  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

    if (diffInSeconds < 60) return t('history:sections.recent')
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m`
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h`
    if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d`
    return date.toLocaleDateString()
  }

  // Get task type icon
  const getTaskTypeIcon = (task: Task) => {
    const isFlow = task.git_url?.includes('flow') || task.branch_name?.includes('flow')
    if (isFlow) {
      return <Workflow className="w-4 h-4 text-purple-500" />
    }
    if (task.is_group_chat) {
      return <Users className="w-4 h-4 text-text-muted" />
    }
    if (task.task_type === 'code') {
      return <Code2 className="w-4 h-4 text-blue-500" />
    }
    return <MessageSquare className="w-4 h-4 text-green-500" />
  }

  // Get status icon
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
      case 'FAILED':
        return <XCircle className="w-3.5 h-3.5 text-red-500" />
      case 'CANCELLED':
        return <StopCircle className="w-3.5 h-3.5 text-orange-500" />
      case 'PENDING':
        return <PauseCircle className="w-3.5 h-3.5 text-yellow-500" />
      case 'RUNNING':
        return <RotateCw className="w-3.5 h-3.5 text-blue-500 animate-spin" />
      default:
        return null
    }
  }

  // Filter button component
  const FilterButton = ({
    type,
    icon: Icon,
    label,
    color,
  }: {
    type: HistoryFilterType
    icon: React.ElementType
    label: string
    color: string
  }) => {
    const isActive = filterTypes.includes(type)
    return (
      <button
        onClick={() => handleFilterChange(type)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
          isActive
            ? `${color} ring-1 ring-current ring-opacity-30`
            : 'bg-surface text-text-muted hover:bg-hover'
        }`}
      >
        <Icon className="w-3.5 h-3.5" />
        <span>{label}</span>
        {isActive && <Check className="w-3 h-3" />}
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">{t('history:title')}</DialogTitle>
        </DialogHeader>

        {/* Filter buttons */}
        <div className="flex items-center gap-2 flex-wrap py-2 border-b border-border">
          <span className="text-xs text-text-muted mr-1">{t('history:filters.all')}:</span>
          <FilterButton
            type="online"
            icon={MessageSquare}
            label={t('history:filters.conversations')}
            color="bg-green-500/10 text-green-600"
          />
          <FilterButton
            type="offline"
            icon={Code2}
            label={t('history:filters.tasks')}
            color="bg-blue-500/10 text-blue-600"
          />
          <FilterButton
            type="flow"
            icon={Workflow}
            label="Flow"
            color="bg-purple-500/10 text-purple-600"
          />
        </div>

        {/* Batch action bar */}
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="flex items-center gap-3">
            <button
              onClick={selectedTaskIds.size === filteredTasks.length ? deselectAll : selectAll}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              {selectedTaskIds.size === filteredTasks.length && filteredTasks.length > 0 ? (
                <CheckSquare className="w-4 h-4" />
              ) : (
                <Square className="w-4 h-4" />
              )}
              <span>
                {selectedTaskIds.size > 0
                  ? t('history:confirm.delete_selected', { count: selectedTaskIds.size })
                  : t('history:actions.view')}
              </span>
            </button>
          </div>

          {selectedTaskIds.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteSelected}
              disabled={isDeleting}
              className="h-7 text-xs"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              {isDeleting ? t('history:status.loading') : t('history:actions.delete')}
            </Button>
          )}
        </div>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto -mx-6 px-6 py-2">
          {isLoading ? (
            <div className="text-center py-12">
              <p className="text-sm text-text-muted">{t('history:status.loading')}</p>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm text-text-muted">{t('history:empty.title')}</p>
              <p className="text-xs text-text-muted mt-1">{t('history:empty.description')}</p>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredTasks.map(task => {
                const isSelected = selectedTaskIds.has(task.id)
                return (
                  <div
                    key={task.id}
                    className={`group flex items-center gap-3 py-2.5 px-3 rounded-lg transition-colors ${
                      isSelected ? 'bg-primary/5' : 'hover:bg-hover'
                    }`}
                  >
                    {/* Checkbox */}
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        toggleTaskSelection(task.id)
                      }}
                      className="flex-shrink-0 text-text-muted hover:text-text-primary"
                    >
                      {isSelected ? (
                        <CheckSquare className="w-4 h-4 text-primary" />
                      ) : (
                        <Square className="w-4 h-4" />
                      )}
                    </button>

                    {/* Task content (clickable) */}
                    <div
                      className="flex-1 flex items-center gap-3 min-w-0 cursor-pointer"
                      onClick={() => handleTaskClick(task)}
                    >
                      {/* Task type icon */}
                      <div className="flex-shrink-0">{getTaskTypeIcon(task)}</div>

                      {/* Task title and time */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-text-primary truncate">{task.title}</p>
                        <div className="flex items-center gap-2 text-xs text-text-muted">
                          <span>{formatTimeAgo(task.created_at)}</span>
                          {getStatusIcon(task.status)}
                        </div>
                      </div>
                    </div>

                    {/* Delete button (individual) */}
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        handleDeleteSingleTask(task.id)
                      }}
                      className="flex-shrink-0 p-1 text-text-muted hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                      title={t('history:actions.delete')}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )
              })}

              {/* Load more button */}
              {hasMore && (
                <button
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                  className="w-full py-2 text-xs text-text-muted hover:text-text-primary transition-colors"
                >
                  {isLoadingMore ? t('history:status.loading') : t('common:tasks.load_more')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="flex-shrink-0 pt-2 border-t border-border">
          <p className="text-xs text-text-muted text-center">
            {t('common:tasks.total_count', { count: filteredTasks.length })}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
