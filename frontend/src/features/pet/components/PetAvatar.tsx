// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * PetAvatar component
 *
 * Renders the pet SVG avatar based on seed, stage, and traits.
 */

import React, { useMemo } from 'react'
import { generatePetSvg, getPetSize } from '@/features/pet/utils/svgGenerator'
import type { Pet, PetAnimationState } from '@/features/pet/types/pet'
import { cn } from '@/lib/utils'

interface PetAvatarProps {
  pet: Pet
  animationState: PetAnimationState
  isMobile?: boolean
  className?: string
}

export function PetAvatar({ pet, animationState, isMobile = false, className }: PetAvatarProps) {
  const svgString = useMemo(() => {
    return generatePetSvg(pet.svg_seed, pet.stage, pet.appearance_traits)
  }, [pet.svg_seed, pet.stage, pet.appearance_traits])

  const size = getPetSize(pet.stage, isMobile)

  return (
    <div
      className={cn(
        'relative transition-transform duration-300',
        animationState === 'idle' && 'animate-pet-idle',
        animationState === 'busy' && 'animate-pet-busy',
        animationState === 'evolving' && 'animate-pet-evolve',
        animationState === 'gaining_exp' && 'animate-pet-gain-exp',
        className
      )}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svgString }}
    />
  )
}
