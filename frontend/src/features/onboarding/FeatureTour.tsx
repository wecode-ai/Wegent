// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useFeatureTour } from './useFeatureTour';

interface FeatureTourProps {
  /** Current page path (e.g., '/chat', '/code') */
  currentPage: string;
  /** Whether the page is still loading */
  isLoading?: boolean;
}

/**
 * FeatureTour component that manages the feature tour experience
 * for users who have completed the initial onboarding.
 *
 * This component automatically triggers feature tours for new features
 * when users visit pages that have unviewed tour content.
 *
 * Key behaviors:
 * - Only triggers for users who have completed onboarding (old users)
 * - New users skip Feature Tour (current version marked as viewed after onboarding)
 * - Each version's tour is shown only once per user
 * - Tours are page-specific (only shows steps for current page)
 */
export default function FeatureTour({ currentPage, isLoading = false }: FeatureTourProps) {
  useFeatureTour({
    currentPage,
    isLoading,
  });

  // This component doesn't render any UI, it just manages the tour logic
  return null;
}
