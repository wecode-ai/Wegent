// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getDefaultKnowledgeView,
  isKnowledgeView,
} from '@/features/knowledge/document/hooks/useKnowledgeViewMode'

describe('knowledge view mode helpers', () => {
  it('maps kb_type to default opening view', () => {
    expect(getDefaultKnowledgeView('classic')).toBe('documents')
    expect(getDefaultKnowledgeView('notebook')).toBe('notebook')
    expect(getDefaultKnowledgeView(undefined)).toBe('notebook')
    expect(getDefaultKnowledgeView(null)).toBe('notebook')
  })

  it('accepts only URL view values supported by the page', () => {
    expect(isKnowledgeView('documents')).toBe(true)
    expect(isKnowledgeView('notebook')).toBe(true)
    expect(isKnowledgeView('classic')).toBe(false)
    expect(isKnowledgeView('abc')).toBe(false)
    expect(isKnowledgeView(null)).toBe(false)
  })
})
