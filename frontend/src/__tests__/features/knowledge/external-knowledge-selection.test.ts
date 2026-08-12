// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getExternalKnowledgeScopeKey,
  isSameExternalKnowledgeScope,
} from '@/features/knowledge/externalKnowledgeSelection'

describe('external knowledge selection identity', () => {
  it('uses provider, mode, and knowledge base id as the canonical scope identity', () => {
    const explicit = { provider: 'ap', mode: 'explicit', id: 'kb-1' }
    const allAccessible = { provider: 'ap', mode: 'all_accessible', id: 'kb-1' }

    expect(getExternalKnowledgeScopeKey(explicit)).toBe('ap:explicit:kb-1')
    expect(isSameExternalKnowledgeScope(explicit, allAccessible)).toBe(false)
  })
})
