// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * PetNotificationPanel component
 *
 * Shows useful notifications and status information on hover.
 * Displays experience bar, task status, unread messages, and helpful tips.
 */

import React, { useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { CheckCircle2, Clock, MessageSquare, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Pet } from '@/features/pet/types/pet'
import { STAGE_THRESHOLDS, STAGE_NAMES } from '@/features/pet/types/pet'

interface PetNotificationPanelProps {
  pet: Pet
  className?: string
}

export function PetNotificationPanel({ pet, className }: PetNotificationPanelProps) {
  const { t } = useTranslation('pet')
  const { tasks, getUnreadCount, viewStatusVersion } = useTaskContext()

  // Calculate task statistics - show running tasks (exclude FAILED, CANCELLED, COMPLETED)
  const taskStats = useMemo(() => {
    const running = tasks.filter(
      task => task.status === 'RUNNING' || task.status === 'PENDING'
    ).length
    const unread = getUnreadCount(tasks)
    return { running, unread }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, viewStatusVersion])

  // Generate greeting based on time of day
  const greeting = useMemo(() => {
    const hour = new Date().getHours()
    if (hour < 12) return t('panel.greeting.morning')
    if (hour < 18) return t('panel.greeting.afternoon')
    return t('panel.greeting.evening')
  }, [t])

  // Calculate experience progress
  const expProgress = useMemo(() => {
    const currentStage = pet.stage
    const currentExp = pet.experience
    const currentStageThreshold = STAGE_THRESHOLDS[currentStage]
    const nextStage = (currentStage + 1) as 1 | 2 | 3
    const nextStageThreshold = STAGE_THRESHOLDS[nextStage] ?? null
    const stageName = STAGE_NAMES[currentStage]

    // If at max stage, show total experience
    if (nextStageThreshold === null) {
      return {
        current: currentExp,
        max: null,
        percentage: 100,
        stageName,
        isMaxStage: true,
      }
    }

    // Calculate progress within current stage
    const expInCurrentStage = currentExp - currentStageThreshold
    const expNeededForNextStage = nextStageThreshold - currentStageThreshold
    const percentage = Math.min(100, (expInCurrentStage / expNeededForNextStage) * 100)

    return {
      current: expInCurrentStage,
      max: expNeededForNextStage,
      percentage,
      stageName,
      isMaxStage: false,
    }
  }, [pet.stage, pet.experience])

  // Check if there are any notifications to show
  const hasNotifications = taskStats.running > 0 || taskStats.unread > 0

  return (
    <div
      className={cn(
        'bg-surface/95 backdrop-blur-sm rounded-lg p-3 shadow-lg border border-border min-w-[200px] max-w-[280px]',
        className
      )}
    >
      {/* Pet name with greeting */}
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="text-sm text-text-primary">
          {pet.pet_name ? (
            <>
              <span className="font-medium">{pet.pet_name}</span>
              <span className="text-text-secondary">：{greeting}</span>
            </>
          ) : (
            greeting
          )}
        </span>
      </div>

      {/* Experience bar section */}
      <div className="mb-3 pb-2 border-b border-border">
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="text-text-secondary">{t(`stages.${expProgress.stageName}`)}</span>
          <span className="text-text-muted">
            {expProgress.isMaxStage
              ? t('panel.exp.total', { exp: expProgress.current })
              : `${expProgress.current} / ${expProgress.max}`}
          </span>
        </div>
        <div className="h-2 bg-border/50 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              expProgress.isMaxStage ? 'bg-amber-400' : 'bg-primary'
            )}
            style={{ width: `${expProgress.percentage}%` }}
          />
        </div>
      </div>

      {/* Notifications section */}
      {hasNotifications ? (
        <div className="space-y-2">
          {/* Running tasks */}
          {taskStats.running > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-amber-500 animate-pulse" />
              <span className="text-text-secondary">
                {t('panel.tasks.running', { count: taskStats.running })}
              </span>
            </div>
          )}

          {/* Unread messages */}
          {taskStats.unread > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <MessageSquare className="w-4 h-4 text-primary" />
              <span className="text-text-secondary">
                {t('panel.tasks.unread', { count: taskStats.unread })}
              </span>
            </div>
          )}
        </div>
      ) : (
        /* All clear message */
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="w-4 h-4 text-green-500" />
          <span className="text-text-secondary">{t('panel.allClear')}</span>
        </div>
      )}
    </div>
  )
}
