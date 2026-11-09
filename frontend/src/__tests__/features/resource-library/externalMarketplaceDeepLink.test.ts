// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { resolveExternalMarketplaceKey } from '@/features/resource-library/externalMarketplaceDeepLink'

const providers = [
  { key: 'weibo', name: 'SkillHub' },
  { key: 'partner', name: 'Partner Skills' },
]

describe('resolveExternalMarketplaceKey', () => {
  it('matches a provider by key', () => {
    expect(resolveExternalMarketplaceKey(providers, 'partner')).toBe('partner')
  })

  it('matches a provider by display name regardless of case', () => {
    expect(resolveExternalMarketplaceKey(providers, ' skillhub ')).toBe('weibo')
  })

  it('returns null for missing or unknown marketplaces', () => {
    expect(resolveExternalMarketplaceKey(providers, null)).toBeNull()
    expect(resolveExternalMarketplaceKey(providers, '')).toBeNull()
    expect(resolveExternalMarketplaceKey(providers, 'unknown')).toBeNull()
  })
})
