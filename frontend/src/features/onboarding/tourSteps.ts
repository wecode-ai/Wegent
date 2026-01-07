// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { DriveStep } from 'driver.js'

export interface TourStepConfig {
  element: string
  popover: {
    title: string
    description: string
  }
}

export const getTourSteps = (
  t: (key: string) => string,
  hasTeams: boolean,
  _hasGitToken: boolean,
  _currentPage: 'chat' | 'code'
): DriveStep[] => {
  const steps: DriveStep[] = []

  // Step 1: Mode toggle (Chat/Code)
  steps.push({
    element: '[data-tour="mode-toggle"]',
    popover: {
      title: t('onboarding.step1_title'),
      description: t('onboarding.step1_description'),
    },
  })

  // Step 2: Quick access cards (switch agents)
  steps.push({
    element: '[data-tour="quick-access-cards"]',
    popover: {
      title: t('onboarding.step2_title'),
      description: t('onboarding.step2_description'),
    },
  })

  // Step 3: Task input
  steps.push({
    element: '[data-tour="task-input"]',
    popover: {
      title: t('onboarding.step3_title'),
      description: t('onboarding.step3_description'),
    },
  })

  // Step 4: Input controls (attachment, team, model)
  steps.push({
    element: '[data-tour="input-controls"]',
    popover: {
      title: t('onboarding.step4_title'),
      description: hasTeams
        ? t('onboarding.step4_description')
        : t('onboarding.step4_description_no_team'),
    },
  })

  // Step 5: Send button
  steps.push({
    element: '[data-tour="send-button"]',
    popover: {
      title: t('onboarding.step5_title'),
      description: t('onboarding.step5_description'),
    },
  })

  // Step 6: Task sidebar
  steps.push({
    element: '[data-tour="task-sidebar"]',
    popover: {
      title: t('onboarding.step6_title'),
      description: t('onboarding.step6_description'),
    },
  })

  // Step 7: Settings link
  steps.push({
    element: '[data-tour="settings-link"]',
    popover: {
      title: t('onboarding.step7_title'),
      description: t('onboarding.step7_description'),
    },
  })

  return steps
}
