// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { FeatureTourConfig } from '@/types/feature-tour';

/**
 * Feature Tour Configuration for Version 1.0.21
 *
 * New features introduced in this version:
 * - AI Cross-Validation: Enables a secondary AI model to verify and improve answers
 */
export const featureTour_v1_0_21: FeatureTourConfig = {
  version: '1.0.21',
  releaseDate: '2025-01',
  pages: {
    '/chat': [
      {
        id: 'ai-cross-validation',
        element: '[data-feature-tour="ai-cross-validation"]',
        titleKey: 'featureTour.v1_0_21.ai_cross_validation_title',
        descriptionKey: 'featureTour.v1_0_21.ai_cross_validation_description',
        position: 'top',
      },
    ],
    // Code page does not have AI cross-validation (it's only for chat shell)
    '/code': [],
  },
};
