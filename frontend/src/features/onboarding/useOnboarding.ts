// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { driver, Driver, AllowedButtons, Config } from 'driver.js';
import { useTranslation } from 'react-i18next';
import 'driver.js/dist/driver.css';
import { getTourSteps } from './tourSteps';

const ONBOARDING_COMPLETED_KEY = 'user_onboarding_completed';
const ONBOARDING_IN_PROGRESS_KEY = 'onboarding_in_progress';
const ONBOARDING_CURRENT_STEP_KEY = 'onboarding_current_step';

interface UseOnboardingOptions {
  hasTeams: boolean;
  hasGitToken: boolean;
  currentPage: 'chat' | 'code';
  isLoading?: boolean;
  hasShareId?: boolean;
}

export const useOnboarding = ({
  hasTeams,
  hasGitToken,
  currentPage,
  isLoading = false,
  hasShareId = false,
}: UseOnboardingOptions) => {
  const { t } = useTranslation('common');
  const router = useRouter();
  const driverInstance = useRef<Driver | null>(null);
  const [isReady, setIsReady] = useState(false);

  const isOnboardingCompleted = () => {
    return localStorage.getItem(ONBOARDING_COMPLETED_KEY) === 'true';
  };

  const markOnboardingCompleted = () => {
    localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
    localStorage.removeItem(ONBOARDING_IN_PROGRESS_KEY);
    localStorage.removeItem(ONBOARDING_CURRENT_STEP_KEY);
  };

  const isOnboardingInProgress = () => {
    return localStorage.getItem(ONBOARDING_IN_PROGRESS_KEY) === 'true';
  };

  const setOnboardingInProgress = (inProgress: boolean) => {
    if (inProgress) {
      localStorage.setItem(ONBOARDING_IN_PROGRESS_KEY, 'true');
    } else {
      localStorage.removeItem(ONBOARDING_IN_PROGRESS_KEY);
    }
  };

  const getCurrentStep = (): number => {
    const step = localStorage.getItem(ONBOARDING_CURRENT_STEP_KEY);
    return step ? parseInt(step, 10) : 0;
  };

  const setCurrentStep = (step: number) => {
    localStorage.setItem(ONBOARDING_CURRENT_STEP_KEY, step.toString());
  };

  const startTour = () => {
    if (isLoading) {
      return;
    }

    const steps = getTourSteps(t, hasTeams, hasGitToken, currentPage);

    const driverConfig: Config = {
      showProgress: true,
      animate: true,
      overlayOpacity: 0.7,
      allowClose: false,
      steps,
      nextBtnText: t('onboarding.next'),
      prevBtnText: t('onboarding.previous'),
      doneBtnText: t('onboarding.done'),
      showButtons: ['next', 'previous', 'close'] as AllowedButtons[],
      onCloseClick: () => {
        markOnboardingCompleted();
        driverInstance.current?.destroy();
      },
      onDestroyed: () => {
        if (!isOnboardingCompleted()) {
          markOnboardingCompleted();
        }
      },
      onNextClick: (_element, _step, { state }) => {
        const activeIndex = state.activeIndex ?? 0;
        setCurrentStep(activeIndex + 1);

        // Check if we need to navigate to code page after step 3 (team selector)
        // Step indices: 0=mode-toggle, 1=task-input, 2=team-selector
        if (activeIndex === 2 && currentPage === 'chat') {
          // Save state before navigation
          setOnboardingInProgress(true);
          setCurrentStep(3); // Next step will be repo-selector on code page

          // Navigate to code page
          router.push('/code');

          // Destroy current driver instance
          driverInstance.current?.destroy();
          return;
        }

        driverInstance.current?.moveNext();
      },
      onPrevClick: () => {
        const activeIndex = driverInstance.current?.getActiveIndex() ?? 0;
        setCurrentStep(Math.max(0, activeIndex - 1));
        driverInstance.current?.movePrevious();
      },
    };

    driverInstance.current = driver(driverConfig);

    // Resume from saved step if in progress
    const savedStep = getCurrentStep();
    if (savedStep > 0) {
      driverInstance.current.drive(savedStep);
    } else {
      driverInstance.current.drive();
    }

    setOnboardingInProgress(true);
  };

  const restartTour = () => {
    localStorage.removeItem(ONBOARDING_COMPLETED_KEY);
    localStorage.removeItem(ONBOARDING_IN_PROGRESS_KEY);
    localStorage.removeItem(ONBOARDING_CURRENT_STEP_KEY);
    router.push('/code');
  };

  useEffect(() => {
    setIsReady(true);
  }, []);

  useEffect(() => {
    if (!isReady || isLoading || hasShareId) {
      return;
    }

    // Auto-start tour if not completed and on first visit
    if (!isOnboardingCompleted() && !isOnboardingInProgress()) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        startTour();
      }, 500);
      return () => clearTimeout(timer);
    }

    // Resume tour if in progress (after page navigation)
    if (isOnboardingInProgress() && currentPage === 'code') {
      const timer = setTimeout(() => {
        startTour();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isReady, isLoading, hasShareId, currentPage]);

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
    restartTour,
    isOnboardingCompleted: isOnboardingCompleted(),
  };
};
