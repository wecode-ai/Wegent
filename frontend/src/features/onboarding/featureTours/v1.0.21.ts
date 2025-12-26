// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { FeatureTourConfig } from '@/types/feature-tour';

/**
 * Feature Tour Configuration for Version 1.0.21
 *
 * This is a sample/placeholder configuration to demonstrate the Feature Tour system.
 * When new features are added in future releases, update this file or create new
 * version-specific configuration files.
 *
 * Usage:
 * 1. Add data-feature-tour="step-id" attribute to new feature elements
 * 2. Define the tour steps below with corresponding element selectors
 * 3. Add i18n keys for titles and descriptions in common.json files
 */
export const featureTour_v1_0_21: FeatureTourConfig = {
  version: '1.0.21',
  releaseDate: '2025-01',
  pages: {
    // Placeholder configuration - no active steps for this version
    // This serves as a template for future feature tours
    //
    // Example of how to add tour steps:
    // '/chat': [
    //   {
    //     id: 'example-feature',
    //     element: '[data-feature-tour="example-feature"]',
    //     titleKey: 'featureTour.v1_0_21.example_title',
    //     descriptionKey: 'featureTour.v1_0_21.example_description',
    //     position: 'bottom',
    //   },
    // ],
    // '/code': [],
    // '/settings': [],
  },
};
