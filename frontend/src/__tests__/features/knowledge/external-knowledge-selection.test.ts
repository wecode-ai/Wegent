// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getExternalKnowledgeScopeKey,
  isSameExternalKnowledgeScope,
} from '@/features/knowledge/externalKnowledgeSelection'

describe('external knowledge selection identity', () => {
  it('uses provider, mode, and knowledge base id as the canonical scope identity', () => {
    const first = { provider: 'demo', mode: 'explicit' as const, id: 'kb-1' }
    const second = { provider: 'demo', mode: 'explicit' as const, id: 'kb-2' }

    expect(getExternalKnowledgeScopeKey(first)).toBe('demo:explicit:kb-1')
    expect(isSameExternalKnowledgeScope(first, second)).toBe(false)
  })
})
