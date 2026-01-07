// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { PanelLeftOpen, Plus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'

interface CollapsedSidebarButtonsProps {
  onExpand: () => void
  onNewTask: () => void
}

export default function CollapsedSidebarButtons({
  onExpand,
  onNewTask,
}: CollapsedSidebarButtonsProps) {
  const { t } = useTranslation()
  const { tasks, getUnreadCount, viewStatusVersion } = useTaskContext()

  // Calculate unread count from task context, same as TaskSidebar
  const hasUnreadTasks = React.useMemo(() => {
    return getUnreadCount(tasks) > 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, getUnreadCount, viewStatusVersion])

  return (
    <div className="fixed top-2 sm:top-3 left-4 z-50">
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-3xl border border-border bg-base shadow-[0px_6px_8px_0px_rgba(51,51,51,0.06)] relative">
        {/* Expand button */}
        <TooltipProvider>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                onClick={onExpand}
                className="flex-shrink-0 p-1.5 -m-1.5 rounded-full hover:bg-hover transition-colors"
                aria-label={t('common:sidebar.expand')}
              >
                <PanelLeftOpen className="h-4 w-4 text-text-primary" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{t('common:sidebar.expand')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* New task button */}
        <TooltipProvider>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                onClick={onNewTask}
                className="flex-shrink-0 p-1.5 -m-1.5 rounded-full hover:bg-hover transition-colors"
                aria-label={t('common:tasks.new_task')}
              >
                <Plus className="h-4 w-4 text-text-primary" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{t('common:tasks.new_task')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {hasUnreadTasks && (
          <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full" />
        )}
      </div>
    </div>
  )
}
