// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * PetAvatar component
 *
 * Renders the pet SVG avatar based on seed, stage, and traits.
 */

import React, { useMemo, useState, useEffect } from 'react'
import { generatePetSvg, getPetSize } from '@/features/pet/utils/svgGenerator'
import type { Pet, PetAnimationState } from '@/features/pet/types/pet'
import { cn } from '@/lib/utils'

// Experience thresholds for feature appearance (matching svgGenerator.ts)
// Designed for 3-5 days between each unlock (assuming ~5-10 messages/day = 5-10 exp/day)
const EXPERIENCE_THRESHOLDS = {
  EYES: 20,
  NOSE: 45,
  MOUTH: 70,
  EARS: 95,
  BLUSH: 120,
  DETAILS: 145,
} as const

interface PetAvatarProps {
  pet: Pet
  animationState: PetAnimationState
  isMobile?: boolean
  className?: string
}

export function PetAvatar({ pet, animationState, isMobile = false, className }: PetAvatarProps) {
  const [previousExperience, setPreviousExperience] = useState(pet.experience)
  const [isExperienceMilestone, setIsExperienceMilestone] = useState(false)

  // Check if a new feature threshold was reached
  useEffect(() => {
    const thresholds = Object.values(EXPERIENCE_THRESHOLDS)
    const crossedThreshold = thresholds.some(
      threshold => previousExperience < threshold && pet.experience >= threshold
    )

    if (crossedThreshold && previousExperience !== pet.experience) {
      setIsExperienceMilestone(true)
      // Reset animation after it completes
      const timer = setTimeout(() => setIsExperienceMilestone(false), 1200)
      setPreviousExperience(pet.experience)
      return () => clearTimeout(timer)
    } else if (previousExperience !== pet.experience) {
      setPreviousExperience(pet.experience)
    }
  }, [pet.experience, previousExperience])

  const svgString = useMemo(() => {
    return generatePetSvg(pet.svg_seed, pet.stage, pet.appearance_traits, pet.experience)
  }, [pet.svg_seed, pet.stage, pet.appearance_traits, pet.experience])

  const size = getPetSize(pet.stage, isMobile)

  return (
    <div
      className={cn(
        'relative transition-transform duration-300',
        animationState === 'idle' && 'animate-pet-idle',
        animationState === 'busy' && 'animate-pet-busy',
        animationState === 'evolving' && 'animate-pet-evolve',
        animationState === 'gaining_exp' && 'animate-pet-gain-exp',
        isExperienceMilestone && 'animate-experience-milestone',
        className
      )}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svgString }}
    />
  )
}
