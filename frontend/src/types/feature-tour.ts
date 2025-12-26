// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Types for the Feature Tour System
 * This system provides guided tours for new features introduced in each version,
 * targeting only users who have completed the initial onboarding.
 */

/**
 * A single step in a feature tour
 */
export interface FeatureTourStep {
  /** Unique identifier for this step */
  id: string;
  /** CSS selector for the target element (e.g., '[data-feature-tour="new-button"]') */
  element: string;
  /** i18n key for the step title */
  titleKey: string;
  /** i18n key for the step description */
  descriptionKey: string;
  /** Optional position of the popover relative to the element */
  position?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * Configuration for a feature tour targeting a specific version
 */
export interface FeatureTourConfig {
  /** Version string (e.g., '1.0.21') */
  version: string;
  /** Release date in YYYY-MM format */
  releaseDate: string;
  /** Map of page paths to their tour steps */
  pages: {
    [pagePath: string]: FeatureTourStep[];
  };
}

/**
 * State of feature tour progress stored in localStorage
 */
export interface FeatureTourState {
  /** Array of version strings that have been viewed */
  viewedVersions: string[];
  /** Current tour in progress (format: 'version:page') or null */
  inProgress: string | null;
  /** Current step index in the active tour */
  currentStep: number;
}

/**
 * Return type for the useFeatureTour hook
 */
export interface UseFeatureTourReturn {
  /** Start the feature tour for the current page */
  startTour: () => void;
  /** Skip the current tour and mark it as viewed */
  skipTour: () => void;
  /** Restart a specific version's tour */
  restartTour: (version: string) => void;
  /** Check if a specific version's tour has been viewed */
  isVersionViewed: (version: string) => boolean;
  /** Get list of available tour versions */
  getAvailableVersions: () => string[];
  /** Whether the feature tour is currently active */
  isActive: boolean;
}

/**
 * Props for the FeatureTour component
 */
export interface FeatureTourProps {
  /** Current page path (e.g., '/chat', '/code') */
  currentPage: string;
  /** Whether the page is still loading */
  isLoading?: boolean;
  /** Optional callback when tour completes */
  onComplete?: () => void;
  /** Optional callback when tour is skipped */
  onSkip?: () => void;
}
