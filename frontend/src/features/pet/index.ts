// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Pet feature index
 */

export { PetProvider, usePet } from './contexts/PetContext'
export { PetWidget, PetAvatar, PetStatusBar, PetSettings, PetStreamingBridge } from './components'
export type {
  Pet,
  PetUpdate,
  PetStage,
  PetStageName,
  PetAnimationState,
  AppearanceTraits,
} from './types/pet'
