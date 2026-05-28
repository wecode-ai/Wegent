// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { useProjectContext } from '@/features/projects'
import { isTaskUnread } from '@/utils/taskViewStatus'
import type { Task } from '@/types/api'
import TaskListSection from './TaskListSection'

interface FixedGroupChatsSectionProps {
  groupTasks: Task[]
  isCollapsed: boolean
  isGroupChatsExpanded: boolean
  setIsGroupChatsExpanded: (expanded: boolean) => void
  hasMoreGroupTasks: boolean
  loadAllGroupTasks: () => Promise<void>
  loadingMoreGroupTasks: boolean
  viewStatusVersion: number
  getUnreadCount: (tasks: Task[]) => number
  setIsMobileSidebarOpen: (open: boolean) => void
}

export default function FixedGroupChatsSection({
  groupTasks,
  isCollapsed,
  isGroupChatsExpanded,
  setIsGroupChatsExpanded,
  hasMoreGroupTasks,
  loadAllGroupTasks,
  loadingMoreGroupTasks,
  viewStatusVersion,
  getUnreadCount,
  setIsMobileSidebarOpen,
}: FixedGroupChatsSectionProps) {
  const { t } = useTranslation()
  const { projectTaskIds } = useProjectContext()

  const filteredGroupTasks = useMemo(
    () => groupTasks.filter(task => !projectTaskIds.has(task.id)),
    [groupTasks, projectTaskIds]
  )

  const unreadGroupChats = filteredGroupTasks.filter(isTaskUnread)
  const readGroupChats = filteredGroupTasks.filter(task => !isTaskUnread(task))
  const orderedGroupChats = [...unreadGroupChats, ...readGroupChats]
  const collapsedGroupChatCount = orderedGroupChats.length
  const shouldShowEmptyState =
    isGroupChatsExpanded && orderedGroupChats.length === 0 && !loadingMoreGroupTasks

  const toggleLabel = isGroupChatsExpanded
    ? t('common:tasks.group_chats_collapse')
    : t('common:tasks.group_chats_expand', {
        count: collapsedGroupChatCount,
        suffix: hasMoreGroupTasks ? '+' : '',
      })

  const handleToggleGroupChats = () => {
    const nextExpanded = !isGroupChatsExpanded
    if (nextExpanded && hasMoreGroupTasks) {
      void loadAllGroupTasks()
    }
    setIsGroupChatsExpanded(nextExpanded)
  }

  return (
    <div
      className={`${isCollapsed ? 'px-0' : 'px-2.5'} py-1 border-t border-border-light shrink-0`}
      data-testid="task-sidebar-group-chat-dock"
    >
      {!isCollapsed ? (
        <>
          <button
            type="button"
            data-testid="task-sidebar-group-chat-toggle"
            aria-label={toggleLabel}
            onClick={handleToggleGroupChats}
            className="flex items-center justify-between w-full h-6 min-w-[44px] px-1 text-xs font-medium rounded-md text-text-muted hover:text-text-primary hover:bg-[rgb(238,238,238)] dark:hover:bg-white/10 transition-colors"
          >
            <span className="truncate">{t('common:tasks.group_chats')}</span>
            {isGroupChatsExpanded ? (
              <ChevronUp
                data-testid="task-sidebar-group-chat-chevron"
                className="h-3.5 w-3.5 flex-shrink-0"
              />
            ) : (
              <ChevronDown
                data-testid="task-sidebar-group-chat-chevron"
                className="h-3.5 w-3.5 flex-shrink-0"
              />
            )}
          </button>
          {isGroupChatsExpanded && orderedGroupChats.length > 0 && (
            <div className="mt-1 max-h-52 overflow-y-auto task-list-scrollbar">
              <TaskListSection
                tasks={orderedGroupChats}
                title=""
                unreadCount={getUnreadCount(orderedGroupChats)}
                onTaskClick={() => setIsMobileSidebarOpen(false)}
                isCollapsed={isCollapsed}
                showTitle={false}
                enableDrag={true}
                key={`group-chats-${viewStatusVersion}`}
              />
            </div>
          )}
          {shouldShowEmptyState && (
            <div className="px-1 py-2 text-xs text-text-muted">
              {t('common:tasks.no_group_chats')}
            </div>
          )}
        </>
      ) : (
        <TooltipProvider>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="task-sidebar-group-chat-toggle"
                aria-label={toggleLabel}
                onClick={handleToggleGroupChats}
                className="flex h-11 min-w-[44px] w-full items-center justify-center text-text-muted hover:text-text-primary transition-colors"
              >
                {isGroupChatsExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{toggleLabel}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {isGroupChatsExpanded && orderedGroupChats.length > 0 && isCollapsed && (
        <div className="max-h-52 overflow-y-auto task-list-scrollbar">
          <TaskListSection
            tasks={orderedGroupChats}
            title=""
            unreadCount={getUnreadCount(orderedGroupChats)}
            onTaskClick={() => setIsMobileSidebarOpen(false)}
            isCollapsed={isCollapsed}
            showTitle={false}
            enableDrag={true}
            key={`group-chats-collapsed-${viewStatusVersion}`}
          />
        </div>
      )}
      {loadingMoreGroupTasks && (
        <div className="text-center py-2 text-xs text-text-muted">{t('common:tasks.loading')}</div>
      )}
    </div>
  )
}
