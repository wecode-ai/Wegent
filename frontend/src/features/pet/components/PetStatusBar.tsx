// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * PetStatusBar component
 *
 * Shows pet name, stage, and experience progress.
 * Displayed on hover over the pet widget.
 */

import React from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { Pet } from '@/features/pet/types/pet'
import { STAGE_NAMES, STAGE_THRESHOLDS } from '@/features/pet/types/pet'
import { cn } from '@/lib/utils'

interface PetStatusBarProps {
  pet: Pet
  className?: string
}

export function PetStatusBar({ pet, className }: PetStatusBarProps) {
  const { t } = useTranslation('pet')

  const stageName = STAGE_NAMES[pet.stage]
  const currentThreshold = STAGE_THRESHOLDS[pet.stage]
  const nextThreshold = pet.stage < 3 ? STAGE_THRESHOLDS[(pet.stage + 1) as 1 | 2 | 3] : null

  // Calculate progress percentage
  let progressPercent = 100
  if (nextThreshold !== null) {
    const currentLevelExp = pet.experience - currentThreshold
    const levelRange = nextThreshold - currentThreshold
    progressPercent = Math.min(100, (currentLevelExp / levelRange) * 100)
  }

  return (
    <div
      className={cn(
        'bg-surface/95 backdrop-blur-sm rounded-lg p-3 shadow-lg border border-border min-w-[160px]',
        className
      )}
    >
      {/* Pet name and stage */}
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-text-primary text-sm truncate max-w-[100px]">
          {pet.pet_name}
        </span>
        <span className="text-xs text-text-secondary bg-primary/10 px-2 py-0.5 rounded-full">
          {t(`stages.${stageName}`)}
        </span>
      </div>

      {/* Experience bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-text-secondary">
          <span>{t('stats.experience')}</span>
          <span>
            {pet.experience}
            {nextThreshold !== null && ` / ${nextThreshold}`}
          </span>
        </div>
        <div className="h-2 bg-border rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-500 ease-out rounded-full"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Streak info */}
      {pet.current_streak > 0 && (
        <div className="mt-2 flex items-center gap-1 text-xs text-text-secondary">
          <span>🔥</span>
          <span>
            {t('stats.streak')}: {pet.current_streak} {t('stats.days')}
          </span>
          {pet.streak_multiplier > 1 && (
            <span className="text-primary ml-1">×{pet.streak_multiplier}</span>
          )}
        </div>
      )}
    </div>
  )
}
