// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ShieldCheck } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface PreserveExecutorIndicatorProps {
  preserveExecutor: boolean
}

/**
 * Read-only indicator showing whether executor is preserved for code tasks.
 * Only displays when preserve_executor is true.
 */
export function PreserveExecutorIndicator({ preserveExecutor }: PreserveExecutorIndicatorProps) {
  const { t } = useTranslation()

  // Only show indicator when executor is preserved
  if (!preserveExecutor) {
    return null
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1 h-8 px-2 rounded-[7px] text-sm bg-primary/10 text-primary border border-primary/20">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>{t('tasks:preserve_executor.preserved') || 'Preserved'}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>
            {t('tasks:preserve_executor.tooltip_preserved') ||
              'Executor is preserved and will not be cleaned up'}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// Keep backward compatibility with old name
export { PreserveExecutorIndicator as PreserveExecutorToggle }
