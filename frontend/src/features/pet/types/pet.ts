// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Pet types for the pet nurturing feature.
 */

export type PetStage = 1 | 2 | 3

export type PetStageName = 'baby' | 'growing' | 'mature'

export interface AppearanceTraits {
  primary_domain: string
  secondary_domain: string | null
  color_tone: string
  accessories: string[]
}

export interface Pet {
  id: number
  user_id: number
  pet_name: string
  stage: PetStage
  experience: number
  total_chats: number
  current_streak: number
  longest_streak: number
  last_active_date: string | null
  appearance_traits: AppearanceTraits
  svg_seed: string
  is_visible: boolean
  experience_to_next_stage: number | null
  streak_multiplier: number
  created_at: string
  updated_at: string
}

export interface PetUpdate {
  pet_name?: string
  is_visible?: boolean
}

export interface ExperienceGainedEvent {
  amount: number
  total: number
  source: 'chat' | 'streak_bonus'
  multiplier: number
}

export interface StageEvolvedEvent {
  old_stage: PetStage
  new_stage: PetStage
  old_stage_name: PetStageName
  new_stage_name: PetStageName
}

export interface TraitsUpdatedEvent {
  traits: AppearanceTraits
}

export type PetAnimationState = 'idle' | 'busy' | 'evolving' | 'gaining_exp'

// Domain to appearance mapping
export const DOMAIN_APPEARANCE_MAP: Record<string, { color_tone: string; accessories: string[] }> =
  {
    legal: {
      color_tone: 'navy',
      accessories: ['bowtie', 'briefcase', 'scales'],
    },
    tech: {
      color_tone: 'teal',
      accessories: ['glasses', 'code_symbol', 'gear'],
    },
    design: {
      color_tone: 'purple',
      accessories: ['paintbrush', 'palette'],
    },
    finance: {
      color_tone: 'gold',
      accessories: ['tie', 'chart'],
    },
    medical: {
      color_tone: 'blue',
      accessories: ['stethoscope', 'heart'],
    },
    education: {
      color_tone: 'green',
      accessories: ['book', 'graduation_cap'],
    },
    general: {
      color_tone: 'gray',
      accessories: [],
    },
  }

// Stage thresholds
export const STAGE_THRESHOLDS: Record<PetStage, number> = {
  1: 0, // Baby: 0-99
  2: 100, // Growing: 100-499
  3: 500, // Mature: 500+
}

// Stage names mapping
export const STAGE_NAMES: Record<PetStage, PetStageName> = {
  1: 'baby',
  2: 'growing',
  3: 'mature',
}
