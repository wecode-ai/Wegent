// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DeviceRunningTask } from '@/apis/devices'
import { useTranslation } from '@/hooks/useTranslation'

interface SlotIndicatorProps {
  used: number
  max: number
  runningTasks?: DeviceRunningTask[]
  className?: string
}

export function SlotIndicator({ used, max, runningTasks = [], className }: SlotIndicatorProps) {
  const { t } = useTranslation('devices')
  const isFull = used >= max

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn('flex items-center gap-1', className)}>
            {Array.from({ length: max }).map((_, index) => (
              <div
                key={index}
                className={cn(
                  'w-2 h-2 rounded-full transition-colors',
                  index < used
                    ? isFull
                      ? 'bg-red-500'
                      : 'bg-primary'
                    : 'bg-gray-200 dark:bg-gray-700'
                )}
              />
            ))}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="space-y-1">
            <p className="font-medium">{t('slots_usage', { used, max })}</p>
            {runningTasks.length > 0 && (
              <div className="text-xs text-text-muted space-y-0.5">
                {runningTasks.slice(0, 5).map(task => (
                  <p key={task.subtask_id} className="truncate">
                    {task.title}
                  </p>
                ))}
              </div>
            )}
            {isFull && <p className="text-xs text-red-500">{t('slots_full_hint')}</p>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
