// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback } from 'react'
import { Shield, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { taskApis } from '@/apis/tasks'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface PreserveExecutorToggleProps {
  taskId: number
  preserveExecutor: boolean
  onToggle?: (preserve: boolean) => void
  variant?: 'button' | 'icon'
  size?: 'sm' | 'default'
}

export function PreserveExecutorToggle({
  taskId,
  preserveExecutor,
  onToggle,
  variant = 'button',
  size = 'sm',
}: PreserveExecutorToggleProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(false)
  const [localPreserveState, setLocalPreserveState] = useState(preserveExecutor)

  // Sync local state with prop when it changes
  React.useEffect(() => {
    setLocalPreserveState(preserveExecutor)
  }, [preserveExecutor])

  const handleToggle = useCallback(async () => {
    setIsLoading(true)
    try {
      const newPreserveState = !localPreserveState
      if (newPreserveState) {
        // Set preserve executor
        await taskApis.setPreserveExecutor(taskId)
        toast({
          title: t('tasks:preserve_executor.enabled_title') || 'Executor Preserved',
          description:
            t('tasks:preserve_executor.enabled_desc') ||
            "This task's executor pod will not be cleaned up after completion.",
        })
      } else {
        // Cancel preserve executor
        await taskApis.cancelPreserveExecutor(taskId)
        toast({
          title: t('tasks:preserve_executor.disabled_title') || 'Executor Cleanup Enabled',
          description:
            t('tasks:preserve_executor.disabled_desc') ||
            "This task's executor pod will be cleaned up normally.",
        })
      }
      setLocalPreserveState(newPreserveState)
      onToggle?.(newPreserveState)
    } catch (error) {
      console.error('Failed to toggle preserve executor:', error)
      toast({
        variant: 'destructive',
        title: t('tasks:preserve_executor.error_title') || 'Failed to Update',
        description:
          (error as Error)?.message ||
          t('tasks:preserve_executor.error_desc') ||
          'Could not update executor preservation setting.',
      })
    } finally {
      setIsLoading(false)
    }
  }, [taskId, localPreserveState, onToggle, t, toast])

  const isPreserved = localPreserveState

  if (variant === 'icon') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={isPreserved ? 'default' : 'outline'}
              size="icon"
              onClick={handleToggle}
              disabled={isLoading}
              className={
                isPreserved
                  ? 'bg-primary text-white hover:bg-primary/90 h-8 w-8 rounded-[7px]'
                  : 'h-8 w-8 rounded-[7px]'
              }
            >
              {isPreserved ? <ShieldCheck className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>
              {isPreserved
                ? t('tasks:preserve_executor.tooltip_preserved') || 'Executor preserved'
                : t('tasks:preserve_executor.tooltip_not_preserved') || 'Preserve executor'}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={isPreserved ? 'default' : 'outline'}
            size={size}
            onClick={handleToggle}
            disabled={isLoading}
            className={
              isPreserved
                ? 'bg-primary text-white hover:bg-primary/90 flex items-center gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm'
                : 'flex items-center gap-1 h-8 pl-2 pr-3 rounded-[7px] text-sm'
            }
          >
            {isPreserved ? (
              <>
                <ShieldCheck className="h-3.5 w-3.5" />
                {t('tasks:preserve_executor.preserved') || 'Preserved'}
              </>
            ) : (
              <>
                <Shield className="h-3.5 w-3.5" />
                {t('tasks:preserve_executor.preserve') || 'Preserve'}
              </>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>
            {isPreserved
              ? t('tasks:preserve_executor.tooltip_preserved') ||
                'Executor is preserved and will not be cleaned up'
              : t('tasks:preserve_executor.tooltip_not_preserved') ||
                'Click to preserve executor from cleanup'}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
