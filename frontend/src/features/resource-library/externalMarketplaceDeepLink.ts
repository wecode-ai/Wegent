// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SkillMarketProvider } from '@/apis/skillMarketplace'

/**
 * URL param that selects an external skill marketplace, e.g. `?marketplace=skillhub`.
 * The resource library keeps the selected marketplace in the URL so a link like
 * `/resource-library?type=skill&marketplace=skillhub&keyword=PDF` opens SkillHub
 * with the search already running.
 */
export const EXTERNAL_MARKETPLACE_PARAM = 'marketplace'

/**
 * Resolves the `marketplace` URL param against the registered providers.
 *
 * Matching is case-insensitive and accepts either the provider key (`weibo`) or
 * its display name (`SkillHub`) so external links can use the name users see.
 */
export function resolveExternalMarketplaceKey(
  providers: SkillMarketProvider[],
  requested: string | null | undefined
): string | null {
  const normalized = requested?.trim().toLowerCase()
  if (!normalized) return null

  const matched = providers.find(
    provider =>
      provider.key.toLowerCase() === normalized || provider.name.toLowerCase() === normalized
  )
  return matched?.key ?? null
}
