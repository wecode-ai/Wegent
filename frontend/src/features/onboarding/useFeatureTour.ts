// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, useCallback } from 'react';
import { driver, Driver, AllowedButtons, Config } from 'driver.js';
import { useTranslation } from 'react-i18next';
import 'driver.js/dist/driver.css';
import type { UseFeatureTourReturn } from '@/types/feature-tour';
import {
  getFeatureTourSteps,
  getNextUnviewedVersionForPage,
  getAllFeatureTourVersions,
  CURRENT_APP_VERSION,
  hasFeatureTourForPage,
} from './featureTours';

// localStorage keys
const ONBOARDING_COMPLETED_KEY = 'user_onboarding_completed';
const FEATURE_TOUR_VIEWED_VERSIONS = 'feature_tour_viewed_versions';
const FEATURE_TOUR_IN_PROGRESS = 'feature_tour_in_progress';
const FEATURE_TOUR_CURRENT_STEP = 'feature_tour_current_step';

interface UseFeatureTourOptions {
  /** Current page path (e.g., '/chat', '/code') */
  currentPage: string;
  /** Whether the page is still loading */
  isLoading?: boolean;
  /** Optional callback when tour completes */
  onComplete?: () => void;
  /** Optional callback when tour is skipped */
  onSkip?: () => void;
}

/**
 * Get viewed versions from localStorage
 */
function getViewedVersions(): string[] {
  try {
    const stored = localStorage.getItem(FEATURE_TOUR_VIEWED_VERSIONS);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Mark a version as viewed in localStorage
 */
function markVersionViewed(version: string): void {
  const viewedVersions = getViewedVersions();
  if (!viewedVersions.includes(version)) {
    viewedVersions.push(version);
    localStorage.setItem(FEATURE_TOUR_VIEWED_VERSIONS, JSON.stringify(viewedVersions));
  }
}

/**
 * Check if onboarding has been completed (user is not a new user)
 */
function isOnboardingCompleted(): boolean {
  return localStorage.getItem(ONBOARDING_COMPLETED_KEY) === 'true';
}

/**
 * Get current tour in progress
 */
function getTourInProgress(): string | null {
  return localStorage.getItem(FEATURE_TOUR_IN_PROGRESS);
}

/**
 * Set tour in progress
 */
function setTourInProgress(value: string | null): void {
  if (value) {
    localStorage.setItem(FEATURE_TOUR_IN_PROGRESS, value);
  } else {
    localStorage.removeItem(FEATURE_TOUR_IN_PROGRESS);
  }
}

/**
 * Get current step index
 */
function getCurrentStep(): number {
  const step = localStorage.getItem(FEATURE_TOUR_CURRENT_STEP);
  return step ? parseInt(step, 10) : 0;
}

/**
 * Set current step index
 */
function setCurrentStep(step: number): void {
  localStorage.setItem(FEATURE_TOUR_CURRENT_STEP, step.toString());
}

/**
 * Clear tour progress
 */
function clearTourProgress(): void {
  localStorage.removeItem(FEATURE_TOUR_IN_PROGRESS);
  localStorage.removeItem(FEATURE_TOUR_CURRENT_STEP);
}

/**
 * Mark current version's Feature Tour as viewed
 * Called when new users complete onboarding
 */
export function markCurrentVersionFeatureTourViewed(): void {
  markVersionViewed(CURRENT_APP_VERSION);
}

/**
 * Reset Feature Tour for a specific version (allows re-viewing)
 */
export function resetFeatureTourForVersion(version: string): void {
  const viewedVersions = getViewedVersions();
  const index = viewedVersions.indexOf(version);
  if (index > -1) {
    viewedVersions.splice(index, 1);
    localStorage.setItem(FEATURE_TOUR_VIEWED_VERSIONS, JSON.stringify(viewedVersions));
  }
  clearTourProgress();
}

/**
 * Hook for managing Feature Tour functionality
 * Only triggers for users who have completed the initial onboarding (old users)
 */
export const useFeatureTour = ({
  currentPage,
  isLoading = false,
  onComplete,
  onSkip,
}: UseFeatureTourOptions): UseFeatureTourReturn => {
  const { t } = useTranslation('common');
  const driverInstance = useRef<Driver | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [activeVersion, setActiveVersion] = useState<string | null>(null);

  /**
   * Check if user should see Feature Tour
   * - Must have completed onboarding (old user)
   * - Must have unviewed tour for current page
   */
  const shouldShowFeatureTour = useCallback((): string | null => {
    // Must be an old user (completed onboarding)
    if (!isOnboardingCompleted()) {
      return null;
    }

    const viewedVersions = getViewedVersions();

    // Check for tour in progress first
    const inProgress = getTourInProgress();
    if (inProgress) {
      const [version, page] = inProgress.split(':');
      if (page === currentPage && !viewedVersions.includes(version)) {
        return version;
      }
    }

    // Find next unviewed version with tours for this page
    return getNextUnviewedVersionForPage(viewedVersions, currentPage);
  }, [currentPage]);

  /**
   * Complete the tour and mark version as viewed
   */
  const completeTour = useCallback(
    (version: string) => {
      markVersionViewed(version);
      clearTourProgress();
      setIsActive(false);
      setActiveVersion(null);
      onComplete?.();
    },
    [onComplete]
  );

  /**
   * Skip the tour (same as completing - marks as viewed)
   */
  const skipTour = useCallback(() => {
    if (activeVersion) {
      markVersionViewed(activeVersion);
      clearTourProgress();
    }
    driverInstance.current?.destroy();
    setIsActive(false);
    setActiveVersion(null);
    onSkip?.();
  }, [activeVersion, onSkip]);

  /**
   * Start the feature tour for a specific version
   */
  const startTourForVersion = useCallback(
    (version: string) => {
      const steps = getFeatureTourSteps(version, currentPage);

      if (steps.length === 0) {
        // No steps for this page, mark as viewed and skip
        markVersionViewed(version);
        return;
      }

      // Check if all target elements exist in DOM
      const validSteps = steps.filter(step => {
        const element = document.querySelector(step.element);
        return element !== null;
      });

      if (validSteps.length === 0) {
        // No valid elements found, skip tour
        markVersionViewed(version);
        return;
      }

      // Convert to driver.js format
      const driverSteps = validSteps.map(step => ({
        element: step.element,
        popover: {
          title: t(step.titleKey),
          description: t(step.descriptionKey),
          side: step.position as 'top' | 'bottom' | 'left' | 'right' | undefined,
        },
      }));

      const driverConfig: Config = {
        showProgress: true,
        animate: true,
        overlayOpacity: 0.7,
        allowClose: true,
        steps: driverSteps,
        nextBtnText: t('featureTour.next'),
        prevBtnText: t('featureTour.previous'),
        doneBtnText: t('featureTour.done'),
        showButtons: ['next', 'previous', 'close'] as AllowedButtons[],
        popoverClass: 'feature-tour-popover',
        onPopoverRender: popover => {
          // Customize close button text to show "Skip"
          const closeBtn = popover.wrapper.querySelector('.driver-popover-close-btn');
          if (closeBtn) {
            closeBtn.textContent = t('featureTour.skip');
          }
        },
        onCloseClick: () => {
          skipTour();
        },
        onDestroyed: () => {
          // If tour was not explicitly skipped, mark as completed
          if (isActive && activeVersion) {
            completeTour(activeVersion);
          }
        },
        onNextClick: (_element, _step, { state }) => {
          const activeIndex = state.activeIndex ?? 0;
          setCurrentStep(activeIndex + 1);
          driverInstance.current?.moveNext();
        },
        onPrevClick: () => {
          const activeIndex = driverInstance.current?.getActiveIndex() ?? 0;
          setCurrentStep(Math.max(0, activeIndex - 1));
          driverInstance.current?.movePrevious();
        },
      };

      driverInstance.current = driver(driverConfig);

      // Set tour in progress
      setTourInProgress(`${version}:${currentPage}`);
      setActiveVersion(version);
      setIsActive(true);

      // Resume from saved step if applicable
      const savedStep = getCurrentStep();
      if (savedStep > 0 && savedStep < driverSteps.length) {
        driverInstance.current.drive(savedStep);
      } else {
        driverInstance.current.drive();
      }
    },
    [currentPage, t, skipTour, completeTour, isActive, activeVersion]
  );

  /**
   * Start the tour (auto-detect version)
   */
  const startTour = useCallback(() => {
    const version = shouldShowFeatureTour();
    if (version) {
      startTourForVersion(version);
    }
  }, [shouldShowFeatureTour, startTourForVersion]);

  /**
   * Restart a specific version's tour
   */
  const restartTour = useCallback(
    (version: string) => {
      resetFeatureTourForVersion(version);
      if (hasFeatureTourForPage(version, currentPage)) {
        // Small delay to ensure state is updated
        setTimeout(() => {
          startTourForVersion(version);
        }, 100);
      }
    },
    [currentPage, startTourForVersion]
  );

  /**
   * Check if a version has been viewed
   */
  const isVersionViewed = useCallback((version: string): boolean => {
    return getViewedVersions().includes(version);
  }, []);

  /**
   * Get all available tour versions
   */
  const getAvailableVersions = useCallback((): string[] => {
    return getAllFeatureTourVersions();
  }, []);

  // Mark component as ready after mount
  useEffect(() => {
    setIsReady(true);
  }, []);

  // Auto-start tour when ready and not loading
  useEffect(() => {
    if (!isReady || isLoading) {
      return;
    }

    const version = shouldShowFeatureTour();
    if (version) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        startTourForVersion(version);
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [isReady, isLoading, shouldShowFeatureTour, startTourForVersion]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (driverInstance.current) {
        driverInstance.current.destroy();
      }
    };
  }, []);

  return {
    startTour,
    skipTour,
    restartTour,
    isVersionViewed,
    getAvailableVersions,
    isActive,
  };
};
