// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useOnboarding } from './useOnboarding'

interface OnboardingTourProps {
  hasTeams: boolean
  hasGitToken: boolean
  currentPage: 'chat' | 'code'
  isLoading?: boolean
  hasShareId?: boolean
}

/**
 * OnboardingTour component that manages the user onboarding experience
 * using driver.js for interactive guided tours.
 *
 * This component automatically triggers the onboarding tour on first visit
 * and can be manually restarted from the settings page.
 */
export default function OnboardingTour({
  hasTeams,
  hasGitToken,
  currentPage,
  isLoading = false,
  hasShareId = false,
}: OnboardingTourProps) {
  useOnboarding({
    hasTeams,
    hasGitToken,
    currentPage,
    isLoading,
    hasShareId,
  })

  // This component doesn't render any UI, it just manages the tour logic
  return null
}
