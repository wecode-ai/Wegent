// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search,
  Plus,
  X,
  CheckCircle2,
  XCircle,
  StopCircle,
  PauseCircle,
  RotateCw,
  Code2,
  MessageSquare,
  Users,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import type { ProjectTask, Task } from '@/types/api'
import { taskApis } from '@/apis/tasks'
import { projectApis } from '@/apis/projects'
import { paths } from '@/config/paths'
import { getTaskTargetHref } from '@/utils/taskRouting'
import type { ProjectTaskPageState } from '@/features/projects/contexts/useProjectTaskPages'

interface ProjectTaskListSource {
  tasks: ProjectTask[]
  page?: ProjectTaskPageState
  loadTasks: (loadMore?: boolean) => Promise<void>
}

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  shortcutDisplayText?: string
  pageType?: 'chat' | 'code' | 'knowledge' | 'task'
  projectId?: number
  projectName?: string
  projectTaskList?: ProjectTaskListSource
  onProjectTaskSelect?: (task: ProjectTask) => void
}

const SEARCH_PAGE_SIZE = 20

type SearchResult = Pick<
  Task,
  'id' | 'title' | 'status' | 'is_group_chat' | 'task_type' | 'knowledge_base_id'
> & {
  created_at?: string | null
  projectTask?: ProjectTask
}

const projectTaskSearchResult = (task: ProjectTask): SearchResult => ({
  id: task.task_id,
  title: task.task_title,
  status: task.task_status,
  is_group_chat: task.is_group_chat,
  created_at: task.updated_at,
  projectTask: task,
})

export default function SearchDialog({
  open,
  onOpenChange,
  shortcutDisplayText = '',
  pageType = 'chat',
  projectId,
  projectName,
  projectTaskList,
  onProjectTaskSelect,
}: SearchDialogProps) {
  const { t } = useTranslation('common')
  const router = useRouter()
  const { tasks, selectTask } = useTaskSession()

  const searchInputRef = useRef<HTMLInputElement>(null)
  const [dialogSearchTerm, setDialogSearchTerm] = useState('')
  const [dialogSearchResults, setDialogSearchResults] = useState<SearchResult[]>([])
  const [isDialogSearching, setIsDialogSearching] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [searchPage, setSearchPage] = useState(0)
  const [searchCursor, setSearchCursor] = useState<string | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const requestVersion = useRef(0)
  const scopedSearch = projectId !== undefined
  const normalizedSearchTerm = dialogSearchTerm.trim()
  const showProjectTaskList = scopedSearch && !normalizedSearchTerm && projectTaskList !== undefined
  const visibleTasks = showProjectTaskList
    ? projectTaskList.tasks.map(projectTaskSearchResult)
    : scopedSearch || normalizedSearchTerm
      ? dialogSearchResults
      : tasks.slice(0, SEARCH_PAGE_SIZE)
  const page = projectTaskList?.page
  const loadProjectTasks = projectTaskList?.loadTasks
  const searching = showProjectTaskList ? !page?.loaded && !page?.error : isDialogSearching
  const loadingMore = showProjectTaskList ? Boolean(page?.loading) : isLoadingMore
  const moreTasks = showProjectTaskList ? Boolean(page?.hasMore) : hasMore
  const failed = showProjectTaskList ? Boolean(page?.error) : searchFailed

  useEffect(() => {
    if (open && showProjectTaskList && !page?.loaded && !page?.loading && !page?.error) {
      void loadProjectTasks?.()
    }
  }, [open, showProjectTaskList, page?.loaded, page?.loading, page?.error, loadProjectTasks])

  useEffect(() => {
    setDialogSearchTerm('')
    setDialogSearchResults([])
    if (!open) return
    const timer = setTimeout(() => searchInputRef.current?.focus(), 100)
    return () => clearTimeout(timer)
  }, [open, projectId])

  const searchInDialog = useCallback(
    async (term: string, page: number, version: number, cursor?: string) => {
      setSearchFailed(false)
      try {
        let items: SearchResult[]
        let more: boolean
        let nextCursor: string | undefined
        if (projectId !== undefined) {
          const result = await projectApis.getProjectTasks(
            projectId,
            SEARCH_PAGE_SIZE,
            cursor,
            term || undefined
          )
          items = result.items.map(projectTaskSearchResult)
          more = result.has_more
          nextCursor = result.next_cursor ?? undefined
        } else {
          const result = await taskApis.searchTasks(term, { page, limit: SEARCH_PAGE_SIZE })
          items = result.items
          more = page * SEARCH_PAGE_SIZE < result.total
        }
        if (version !== requestVersion.current) return
        setDialogSearchResults(previous => {
          if (page === 1) return items
          const previousIds = new Set(previous.map(task => task.id))
          return [...previous, ...items.filter(task => !previousIds.has(task.id))]
        })
        setSearchPage(page)
        setSearchCursor(nextCursor)
        setHasMore(more)
      } catch (error) {
        if (version !== requestVersion.current) return
        console.error('Failed to search tasks in dialog:', error)
        setSearchFailed(true)
      } finally {
        if (version === requestVersion.current) {
          setIsDialogSearching(false)
          setIsLoadingMore(false)
        }
      }
    },
    [projectId]
  )

  useEffect(() => {
    const version = ++requestVersion.current
    setDialogSearchResults([])
    setSearchPage(0)
    setSearchCursor(undefined)
    setHasMore(false)
    setSearchFailed(false)
    setIsLoadingMore(false)
    const shouldFetch =
      open && !showProjectTaskList && (scopedSearch || Boolean(normalizedSearchTerm))
    setIsDialogSearching(shouldFetch)
    if (!shouldFetch) return

    const timer = setTimeout(
      () => {
        void searchInDialog(normalizedSearchTerm, 1, version)
      },
      normalizedSearchTerm ? 300 : 0
    )
    return () => {
      clearTimeout(timer)
      requestVersion.current += 1
    }
  }, [open, normalizedSearchTerm, scopedSearch, showProjectTaskList, searchInDialog])

  const handleLoadMore = () => {
    if (searching || loadingMore) return
    if (showProjectTaskList) {
      void loadProjectTasks?.(Boolean(page?.loaded))
      return
    }
    setIsDialogSearching(searchPage === 0)
    setIsLoadingMore(searchPage > 0)
    void searchInDialog(normalizedSearchTerm, searchPage + 1, requestVersion.current, searchCursor)
  }

  const handleClearDialogSearch = () => {
    if (normalizedSearchTerm) {
      requestVersion.current += 1
      setDialogSearchResults([])
    }
    setDialogSearchTerm('')
    searchInputRef.current?.focus()
  }

  // Handle dialog close
  const handleCloseSearchDialog = () => {
    requestVersion.current += 1
    setDialogSearchTerm('')
    setDialogSearchResults([])
    onOpenChange(false)
  }

  // Handle task click in dialog
  const handleDialogTaskClick = (task: SearchResult) => {
    handleCloseSearchDialog()
    if (task.projectTask && onProjectTaskSelect) {
      onProjectTaskSelect(task.projectTask)
    } else {
      router.push(getTaskTargetHref(task))
    }
  }

  // Handle new conversation click
  const handleNewAgentClick = () => {
    handleCloseSearchDialog()
    selectTask(null)
    // Navigate to appropriate page based on pageType
    const targetPath = pageType === 'code' ? paths.chat.getCodeHref() : paths.chat.getHref()
    router.replace(targetPath)
  }

  // Format time ago
  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

    if (diffInSeconds < 60) return 'just now'
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`
    if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`
    return date.toLocaleDateString()
  }

  // Get task type icon
  const getTaskTypeIcon = (task: SearchResult) => {
    if (task.is_group_chat) {
      return <Users className="w-4 h-4 text-text-muted" />
    }
    if (task.task_type === 'code') {
      return <Code2 className="w-4 h-4 text-text-muted" />
    }
    return <MessageSquare className="w-4 h-4 text-text-muted" />
  }

  // Get status icon
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />
      case 'FAILED':
        return <XCircle className="w-4 h-4 text-red-500" />
      case 'CANCELLED':
        return <StopCircle className="w-4 h-4 text-orange-500" />
      case 'PENDING':
        return <PauseCircle className="w-4 h-4 text-yellow-500" />
      case 'RUNNING':
        return <RotateCw className="w-4 h-4 text-blue-500 animate-spin" />
      default:
        return null
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={open => {
        if (!open) {
          handleCloseSearchDialog()
        } else {
          onOpenChange(true)
        }
      }}
    >
      <DialogContent
        className="sm:max-w-[678px] max-h-[440px] flex flex-col"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>
            {scopedSearch
              ? t('projects:search.title', { name: projectName })
              : t('common:tasks.search_placeholder_chat')}
          </DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-text-muted" />
          <input
            ref={searchInputRef}
            data-testid="task-search-input"
            type="text"
            value={dialogSearchTerm}
            onChange={event => {
              if (event.target.value.trim() !== normalizedSearchTerm) {
                requestVersion.current += 1
              }
              setDialogSearchTerm(event.target.value)
            }}
            placeholder={
              shortcutDisplayText
                ? t('common:tasks.search_placeholder_with_shortcut', {
                    shortcut: shortcutDisplayText,
                  })
                : t('common:tasks.search_placeholder_chat')
            }
            className="w-full pl-10 pr-10 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
          />
          {dialogSearchTerm && (
            <button
              type="button"
              data-testid="task-search-clear-button"
              aria-label={t('common:tasks.clear_search')}
              onClick={handleClearDialogSearch}
              className="absolute right-3 top-1/2 transform -translate-y-1/2"
            >
              <X className="h-4 w-4 text-text-muted hover:text-text-primary" />
            </button>
          )}
        </div>

        {/* New Conversation Button - below search input */}
        {!scopedSearch && (
          <div
            className="flex items-center gap-3 py-2.5 px-3 mt-2 rounded-lg hover:bg-hover cursor-pointer transition-colors border border-dashed border-border"
            onClick={handleNewAgentClick}
          >
            <div className="flex-shrink-0">
              <Plus className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-primary font-medium">
                {t('common:tasks.new_conversation')}
              </p>
            </div>
          </div>
        )}

        {/* Search Results List or Recent Tasks */}
        <div className="flex-1 overflow-y-auto mt-3 -mx-6 px-6">
          {searching ? (
            <div className="text-center py-8 text-sm text-text-muted">
              {t('common:tasks.searching')}
            </div>
          ) : failed && visibleTasks.length === 0 ? (
            <button
              type="button"
              data-testid="task-search-retry-button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="min-h-11 w-full py-2 text-sm text-text-muted hover:text-text-primary"
            >
              {t('common:tasks.search_failed')}
            </button>
          ) : normalizedSearchTerm && visibleTasks.length === 0 ? (
            <div className="text-center py-8 text-sm text-text-muted">
              {t('common:tasks.no_search_results')}
            </div>
          ) : visibleTasks.length > 0 ? (
            <div className="space-y-1">
              {visibleTasks.map(task => (
                <button
                  type="button"
                  data-testid={`task-search-result-${task.id}`}
                  key={task.id}
                  className="flex min-h-11 w-full items-center gap-3 py-2.5 px-3 rounded-lg text-left hover:bg-hover cursor-pointer transition-colors"
                  onClick={() => handleDialogTaskClick(task)}
                >
                  {/* Task type icon */}
                  <div className="flex-shrink-0">{getTaskTypeIcon(task)}</div>

                  {/* Task title and time */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary truncate">{task.title}</p>
                    {task.created_at && (
                      <p className="text-xs text-text-muted">{formatTimeAgo(task.created_at)}</p>
                    )}
                  </div>

                  {/* Status icon */}
                  <div className="flex-shrink-0">{getStatusIcon(task.status)}</div>
                </button>
              ))}
              {moreTasks && (
                <button
                  type="button"
                  data-testid="task-search-load-more-button"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="min-h-11 w-full rounded-lg px-3 py-2 text-sm text-text-muted hover:bg-hover hover:text-text-primary disabled:opacity-60"
                >
                  {loadingMore
                    ? t('common:tasks.loading')
                    : failed
                      ? t('common:tasks.search_failed')
                      : t('common:tasks.load_more')}
                </button>
              )}
            </div>
          ) : !normalizedSearchTerm ? (
            <div className="text-center py-8 text-sm text-text-muted">
              {t('common:tasks.no_tasks')}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
