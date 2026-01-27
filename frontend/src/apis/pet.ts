// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Pet API module for pet nurturing feature.
 */

import { apiClient } from './client'
import type { Pet, PetUpdate } from '@/features/pet/types/pet'

export const petApis = {
  /**
   * Get current user's pet.
   * If no pet exists, a new one will be created automatically.
   */
  async getPet(): Promise<Pet> {
    return apiClient.get('/users/me/pet')
  },

  /**
   * Update current user's pet settings.
   * Can update pet name and visibility.
   */
  async updatePet(data: PetUpdate): Promise<Pet> {
    return apiClient.put('/users/me/pet', data)
  },

  /**
   * Reset current user's pet.
   * This will reset all stats and generate a new appearance seed.
   * Visibility preference is preserved.
   */
  async resetPet(): Promise<Pet> {
    return apiClient.post('/users/me/pet/reset')
  },
}
