// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Button } from '@/components/ui/button';
import { PanelLeftOpen, Plus } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/hooks/useTranslation';

interface CollapsedSidebarButtonsProps {
  onExpand: () => void;
  onNewTask: () => void;
  hasCompletedTask: boolean;
}

export default function CollapsedSidebarButtons({
  onExpand,
  onNewTask,
  hasCompletedTask,
}: CollapsedSidebarButtonsProps) {
  const { t } = useTranslation('common');

  return (
    <div className="fixed top-4 left-4 z-50 flex items-center gap-1">
      <TooltipProvider>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onExpand}
              className="h-9 w-9 bg-surface border border-border shadow-sm hover:bg-hover relative"
              aria-label={t('sidebar.expand')}
            >
              <PanelLeftOpen className="h-4 w-4" />
              {hasCompletedTask && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{t('sidebar.expand')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onNewTask}
              className="h-9 w-9 bg-surface border border-border shadow-sm hover:bg-hover"
              aria-label={t('tasks.new_task')}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{t('tasks.new_task')}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
