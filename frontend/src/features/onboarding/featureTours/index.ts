// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { FeatureTourConfig } from '@/types/feature-tour';
import { featureTour_v1_0_21 } from './v1.0.21';

/**
 * Current application version for Feature Tour
 * Update this when releasing new versions with feature tours
 */
export const CURRENT_APP_VERSION = '1.0.21';

/**
 * All available feature tour configurations
 * Add new versions here as they are created
 */
export const featureTourConfigs: FeatureTourConfig[] = [featureTour_v1_0_21];

/**
 * Get feature tour configuration for a specific version
 */
export function getFeatureTourConfig(version: string): FeatureTourConfig | undefined {
  return featureTourConfigs.find(config => config.version === version);
}

/**
 * Get all available feature tour versions
 */
export function getAllFeatureTourVersions(): string[] {
  return featureTourConfigs.map(config => config.version);
}

/**
 * Get the latest feature tour version
 */
export function getLatestFeatureTourVersion(): string {
  return CURRENT_APP_VERSION;
}

/**
 * Get feature tour steps for a specific version and page
 */
export function getFeatureTourSteps(version: string, pagePath: string) {
  const config = getFeatureTourConfig(version);
  if (!config) return [];

  // Normalize page path (remove trailing slash, handle root)
  const normalizedPath = pagePath === '/' ? '/' : pagePath.replace(/\/$/, '');

  return config.pages[normalizedPath] || [];
}

/**
 * Check if a version has tour steps for a specific page
 */
export function hasFeatureTourForPage(version: string, pagePath: string): boolean {
  const steps = getFeatureTourSteps(version, pagePath);
  return steps.length > 0;
}

/**
 * Get all versions that have unviewed tours
 * @param viewedVersions Array of already viewed version strings
 */
export function getUnviewedVersions(viewedVersions: string[]): string[] {
  return featureTourConfigs
    .filter(config => !viewedVersions.includes(config.version))
    .map(config => config.version);
}

/**
 * Get the next unviewed version that has tours for a specific page
 * @param viewedVersions Array of already viewed version strings
 * @param pagePath Current page path
 */
export function getNextUnviewedVersionForPage(
  viewedVersions: string[],
  pagePath: string
): string | null {
  const unviewedVersions = getUnviewedVersions(viewedVersions);

  for (const version of unviewedVersions) {
    if (hasFeatureTourForPage(version, pagePath)) {
      return version;
    }
  }

  return null;
}
