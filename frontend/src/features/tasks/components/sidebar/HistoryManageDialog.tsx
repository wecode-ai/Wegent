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
  AlertTriangle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { Task } from '@/types/api'
import { taskApis } from '@/apis/tasks'
import { getTaskTargetHref } from '@/utils/taskRouting'

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
  initialTaskId?: number | null
}

const PAGE_SIZE = 20
const DELETE_BATCH_SIZE = 50

export default function HistoryManageDialog({
  open,
  onOpenChange,
  initialTaskId,
}: HistoryManageDialogProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const { refreshPersonalTasks } = useTaskSession()

  // Filter types state
  const [filterTypes, setFilterTypes] = useState<HistoryFilterType[]>(['online', 'offline'])

  // Selected tasks for batch delete
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<number>>(new Set())
  // Whether user has opted to select ALL tasks (including unloaded pages)
  const [isSelectingAll, setIsSelectingAll] = useState(false)

  // Is deleting
  const [isDeleting, setIsDeleting] = useState(false)

  // Clear all confirmation dialog
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false)
  const [showDeleteSelectedConfirm, setShowDeleteSelectedConfirm] = useState(false)

  // Pagination state - load data independently
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [total, setTotal] = useState(0)
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
          setTotal(result.total)
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
      setIsSelectingAll(false)
      setSelectedTaskIds(initialTaskId ? new Set([initialTaskId]) : new Set())
      loadTasks(1, false, savedTypes)
    }
  }, [open, initialTaskId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load more handler
  const handleLoadMore = useCallback(() => {
    if (!isLoadingMore && hasMore) {
      loadTasks(currentPage + 1, true)
    }
  }, [currentPage, hasMore, isLoadingMore, loadTasks])

  // Save filter types when changed and reload
  const handleFilterChange = (type: HistoryFilterType) => {
    setIsSelectingAll(false)
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
      setSelectedTaskIds(new Set())
      loadTasks(1, false, newTypes)
      return newTypes
    })
  }

  // Tasks are already filtered by API, just use them directly
  const filteredTasks = allTasks

  const deleteTaskIdsInBatches = useCallback(async (taskIds: number[]) => {
    for (let index = 0; index < taskIds.length; index += DELETE_BATCH_SIZE) {
      await taskApis.bulkDeleteTasks(taskIds.slice(index, index + DELETE_BATCH_SIZE))
    }
  }, [])

  const deleteAllPersonalTasksInBatches = useCallback(async () => {
    let deletedCount: number
    do {
      const result = await taskApis.deleteAllPersonalTasks()
      deletedCount = result.count
    } while (deletedCount > 0)
  }, [])

  // Clear selection when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedTaskIds(new Set())
      setIsSelectingAll(false)
    }
  }, [open])

  // Toggle task selection
  const toggleTaskSelection = (taskId: number) => {
    setIsSelectingAll(false)
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

  // Select all loaded tasks
  const selectAll = () => {
    setSelectedTaskIds(new Set(filteredTasks.map(t => t.id)))
  }

  // Deselect all
  const deselectAll = () => {
    setIsSelectingAll(false)
    setSelectedTaskIds(new Set())
  }

  // Whether all loaded tasks are selected
  const allLoadedSelected =
    filteredTasks.length > 0 && filteredTasks.every(task => selectedTaskIds.has(task.id))

  // Handle the select-all / deselect-all toggle
  const handleSelectAllToggle = () => {
    if (isSelectingAll || allLoadedSelected) {
      deselectAll()
    } else {
      selectAll()
    }
  }

  // Delete selected tasks (or all if isSelectingAll)
  const handleDeleteSelected = useCallback(async () => {
    if (selectedTaskIds.size === 0 && !isSelectingAll) return

    setIsDeleting(true)
    try {
      if (isSelectingAll) {
        await deleteAllPersonalTasksInBatches()
        setIsSelectingAll(false)
        setSelectedTaskIds(new Set())
      } else {
        const ids = Array.from(selectedTaskIds)
        await deleteTaskIdsInBatches(ids)
        setSelectedTaskIds(new Set())
      }
      setAllTasks([])
      loadTasks(1, false)
      refreshPersonalTasks()
    } catch (error) {
      console.error('Failed to delete tasks:', error)
    } finally {
      setIsDeleting(false)
    }
  }, [
    selectedTaskIds,
    isSelectingAll,
    deleteAllPersonalTasksInBatches,
    deleteTaskIdsInBatches,
    loadTasks,
    refreshPersonalTasks,
  ])

  // Handle clear all button
  const handleClearAll = useCallback(async () => {
    setShowClearAllConfirm(false)
    setIsDeleting(true)
    try {
      await deleteAllPersonalTasksInBatches()
      setSelectedTaskIds(new Set())
      setIsSelectingAll(false)
      setAllTasks([])
      loadTasks(1, false)
      refreshPersonalTasks()
    } catch (error) {
      console.error('Failed to clear all tasks:', error)
    } finally {
      setIsDeleting(false)
    }
  }, [deleteAllPersonalTasksInBatches, loadTasks, refreshPersonalTasks])

  // Delete single task
  const handleDeleteSingleTask = useCallback(
    async (taskId: number) => {
      try {
        await taskApis.deleteTask(taskId)
        setAllTasks(prev => prev.filter(t => t.id !== taskId))
        setSelectedTaskIds(prev => {
          const next = new Set(prev)
          next.delete(taskId)
          return next
        })
        setTotal(prev => Math.max(0, prev - 1))
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
    router.push(getTaskTargetHref(task))
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

  const activeCount = isSelectingAll ? total : selectedTaskIds.size

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center justify-between">
              <span>{t('history:title')}</span>
              {filteredTasks.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowClearAllConfirm(true)}
                  disabled={isDeleting}
                  className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                  data-testid="history-clear-all-button"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  {t('history:actions.clear_all')}
                </Button>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">{t('history:description')}</DialogDescription>
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
                onClick={handleSelectAllToggle}
                className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
                data-testid="history-select-all-toggle"
              >
                {isSelectingAll || (allLoadedSelected && filteredTasks.length > 0) ? (
                  <CheckSquare className="w-4 h-4 text-primary" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
                <span>
                  {activeCount > 0
                    ? t('history:actions.selected_count', { count: activeCount })
                    : t('history:actions.select_all')}
                </span>
              </button>

              {/* Select all across pages prompt */}
              {allLoadedSelected && hasMore && !isSelectingAll && (
                <button
                  onClick={() => setIsSelectingAll(true)}
                  className="text-xs text-primary hover:underline transition-colors"
                  data-testid="history-select-all-pages-button"
                >
                  {t('history:actions.select_all_count', { count: total })}
                </button>
              )}
            </div>

            {activeCount > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDeleteSelectedConfirm(true)}
                disabled={isDeleting}
                className="h-7 text-xs"
                data-testid="history-delete-selected-button"
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
                  const isSelected = isSelectingAll || selectedTaskIds.has(task.id)
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
                        className="flex h-11 w-11 min-w-[44px] flex-shrink-0 items-center justify-center text-text-muted hover:text-text-primary lg:h-8 lg:w-8 lg:min-w-8"
                        aria-label={t('history:actions.select_task', { title: task.title })}
                        data-testid={`history-task-checkbox-${task.id}`}
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
                        <div className="flex-shrink-0">{getTaskTypeIcon(task)}</div>

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
                        className="flex h-11 w-11 min-w-[44px] flex-shrink-0 items-center justify-center text-text-muted transition-all hover:text-red-500 lg:h-8 lg:w-8 lg:min-w-8 lg:opacity-0 lg:group-hover:opacity-100"
                        aria-label={t('common:tasks.delete_task')}
                        data-testid={`history-task-delete-${task.id}`}
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
              {t('common:tasks.total_count', { count: total || filteredTasks.length })}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Selected tasks confirmation dialog */}
      <AlertDialog open={showDeleteSelectedConfirm} onOpenChange={setShowDeleteSelectedConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              {t('history:actions.bulk_delete')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('history:confirm.delete_selected', { count: activeCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowDeleteSelectedConfirm(false)
                void handleDeleteSelected()
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="history-confirm-delete-selected-button"
            >
              {t('history:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear all confirmation dialog */}
      <AlertDialog open={showClearAllConfirm} onOpenChange={setShowClearAllConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              {t('history:actions.clear_all')}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('history:confirm.clear_all')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="history-confirm-clear-all-button"
            >
              {t('history:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
