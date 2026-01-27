// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * EvolutionAnimation component
 *
 * Full-screen overlay animation when pet evolves to a new stage.
 */

import React, { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { STAGE_NAMES, type PetStage } from '@/features/pet/types/pet'
import { cn } from '@/lib/utils'

interface EvolutionAnimationProps {
  oldStage: PetStage
  newStage: PetStage
  onComplete: () => void
}

export function EvolutionAnimation({ oldStage, newStage, onComplete }: EvolutionAnimationProps) {
  const { t } = useTranslation('pet')
  const [phase, setPhase] = useState<'enter' | 'show' | 'exit'>('enter')

  const newStageName = STAGE_NAMES[newStage]

  useEffect(() => {
    // Enter phase
    const enterTimer = setTimeout(() => setPhase('show'), 500)

    // Show phase
    const showTimer = setTimeout(() => setPhase('exit'), 2500)

    // Exit phase
    const exitTimer = setTimeout(() => onComplete(), 3000)

    return () => {
      clearTimeout(enterTimer)
      clearTimeout(showTimer)
      clearTimeout(exitTimer)
    }
  }, [onComplete])

  return (
    <div
      className={cn(
        'fixed inset-0 z-[100] flex items-center justify-center',
        'bg-black/50 backdrop-blur-sm',
        'transition-opacity duration-500',
        phase === 'enter' && 'opacity-0',
        phase === 'show' && 'opacity-100',
        phase === 'exit' && 'opacity-0'
      )}
    >
      <div
        className={cn(
          'text-center transition-all duration-500',
          phase === 'enter' && 'scale-50 opacity-0',
          phase === 'show' && 'scale-100 opacity-100',
          phase === 'exit' && 'scale-150 opacity-0'
        )}
      >
        {/* Sparkle effects */}
        <div className="relative mb-4">
          <div className="absolute -inset-8 animate-spin-slow">
            {[...Array(8)].map((_, i) => (
              <div
                key={i}
                className="absolute w-3 h-3 bg-yellow-400 rounded-full animate-pulse"
                style={{
                  left: '50%',
                  top: '50%',
                  transform: `rotate(${i * 45}deg) translateY(-40px)`,
                }}
              />
            ))}
          </div>

          {/* Stage icon */}
          <div className="text-6xl animate-bounce">
            {newStage === 2 ? '🌱' : newStage === 3 ? '🌟' : '🥚'}
          </div>
        </div>

        {/* Evolution text */}
        <div className="text-white">
          <p className="text-2xl font-bold mb-2 animate-pulse">
            {t('notifications.evolved', { stage: t(`stages.${newStageName}`) })}
          </p>
          <p className="text-lg opacity-80">
            {t(`stages.${STAGE_NAMES[oldStage]}`)} → {t(`stages.${newStageName}`)}
          </p>
        </div>
      </div>
    </div>
  )
}
