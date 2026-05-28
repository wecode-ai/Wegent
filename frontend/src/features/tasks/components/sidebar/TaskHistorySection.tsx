// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import { ChevronDown, Search, Settings2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { DroppableHistory, ProjectSection, useProjectContext } from '@/features/projects'
import type { Task } from '@/types/api'
import TaskListSection from './TaskListSection'

interface TaskHistorySectionProps {
  groupTasks: Task[]
  personalTasks: Task[]
  isCollapsed: boolean
  hasMorePersonalTasks: boolean
  loadMorePersonalTasks: () => void
  loadingMorePersonalTasks: boolean
  viewStatusVersion: number
  getUnreadCount: (tasks: Task[]) => number
  totalUnreadCount: number
  handleMarkAllAsViewed: () => void
  handleOpenSearchDialog: () => void
  shortcutDisplayText: string
  setIsMobileSidebarOpen: (open: boolean) => void
  isSearchResult: boolean
  onTaskSelect: () => void
  setIsHistoryManageDialogOpen?: (open: boolean) => void
}

/**
 * Uses useProjectContext to filter tasks.
 * This component must be rendered within ProjectProvider.
 */
export default function TaskHistorySection({
  groupTasks,
  personalTasks,
  isCollapsed,
  hasMorePersonalTasks,
  loadMorePersonalTasks,
  loadingMorePersonalTasks,
  viewStatusVersion,
  getUnreadCount,
  totalUnreadCount,
  handleMarkAllAsViewed,
  handleOpenSearchDialog,
  shortcutDisplayText,
  setIsMobileSidebarOpen,
  isSearchResult,
  onTaskSelect,
  setIsHistoryManageDialogOpen,
}: TaskHistorySectionProps) {
  const { t } = useTranslation()
  const { projectTaskIds, projects } = useProjectContext()

  // Filter out tasks that are already in projects from history lists.
  const filteredPersonalTasks = useMemo(
    () => personalTasks.filter(task => !projectTaskIds.has(task.id)),
    [personalTasks, projectTaskIds]
  )
  const filteredGroupTasks = useMemo(
    () => groupTasks.filter(task => !projectTaskIds.has(task.id)),
    [groupTasks, projectTaskIds]
  )

  const hasProjectsWithTasks = projects.some(project => project.tasks && project.tasks.length > 0)

  if (
    filteredGroupTasks.length === 0 &&
    filteredPersonalTasks.length === 0 &&
    !hasProjectsWithTasks
  ) {
    return (
      <div className="text-center py-8 text-xs text-text-muted">{t('common:tasks.no_tasks')}</div>
    )
  }

  return (
    <>
      {!isCollapsed && !isSearchResult && <ProjectSection onTaskSelect={onTaskSelect} />}

      {filteredPersonalTasks.length > 0 && (
        <DroppableHistory>
          {!isCollapsed && (
            <div className="px-1 pb-1 pt-2 mt-1.5 border-t border-border-light text-xs font-medium text-text-muted flex items-center justify-between">
              <div className="flex items-center gap-1">
                {setIsHistoryManageDialogOpen ? (
                  <TooltipProvider>
                    <Tooltip delayDuration={300}>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => setIsHistoryManageDialogOpen(true)}
                          className="flex items-center gap-1 hover:text-text-primary transition-colors group"
                        >
                          <span className="group-hover:underline">
                            {t('common:tasks.history_title')}
                          </span>
                          <Settings2 className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>{t('history:actions.search')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <span>{t('common:tasks.history_title')}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {totalUnreadCount > 0 && (
                  <button
                    onClick={handleMarkAllAsViewed}
                    className="text-xs text-text-muted hover:text-text-primary transition-colors whitespace-nowrap"
                  >
                    {t('common:tasks.mark_all_read')}
                  </button>
                )}
                <TooltipProvider>
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleOpenSearchDialog}
                        className="p-0.5 text-text-muted hover:text-text-primary transition-colors rounded"
                        aria-label={t('common:tasks.search_placeholder_chat')}
                      >
                        <Search className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>
                        {shortcutDisplayText
                          ? t('common:tasks.search_hint_with_shortcut', {
                              shortcut: shortcutDisplayText,
                            })
                          : t('common:tasks.search_placeholder_chat')}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          )}
          <TaskListSection
            tasks={filteredPersonalTasks}
            title=""
            unreadCount={getUnreadCount(filteredPersonalTasks)}
            onTaskClick={() => setIsMobileSidebarOpen(false)}
            isCollapsed={isCollapsed}
            showTitle={false}
            enableDrag={true}
            key={`regular-tasks-${viewStatusVersion}`}
          />
          {hasMorePersonalTasks && !isCollapsed && (
            <button
              type="button"
              data-testid="load-more-personal-tasks-button"
              onClick={() => {
                void loadMorePersonalTasks()
              }}
              disabled={loadingMorePersonalTasks}
              className="flex h-11 min-w-[44px] w-full items-center gap-1 rounded-xl px-3 text-xs font-medium text-text-muted transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ChevronDown className="h-3.5 w-3.5" />
              <span>
                {loadingMorePersonalTasks ? t('common:tasks.loading') : t('common:tasks.load_more')}
              </span>
            </button>
          )}
          {loadingMorePersonalTasks && (
            <div className="text-center py-2 text-xs text-text-muted">
              {t('common:tasks.loading')}
            </div>
          )}
        </DroppableHistory>
      )}
    </>
  )
}
