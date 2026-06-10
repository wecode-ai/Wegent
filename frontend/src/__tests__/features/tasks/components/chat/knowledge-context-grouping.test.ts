// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { buildKnowledgeContextGroups } from '@/features/tasks/components/chat/knowledge-context/knowledgeContextGrouping'
import type { KnowledgeBase } from '@/types/api'

function makeKnowledgeBase(overrides: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    id: 1,
    name: 'Knowledge Base',
    description: null,
    user_id: 1,
    namespace: 'default',
    document_count: 0,
    is_active: true,
    summary_enabled: false,
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const labels = {
  bound: 'Bound',
  personal: 'Personal',
  groupSection: 'Group',
  organization: 'Organization',
  createdByMe: 'Created by Me',
  groupFallback: 'Unnamed Group',
}

describe('knowledge context grouping', () => {
  it('groups personal, group, and organization knowledge bases into cascade scopes', () => {
    const personal = makeKnowledgeBase({ id: 1, name: 'Personal KB' })
    const group = makeKnowledgeBase({
      id: 2,
      name: 'Group KB',
      namespace: 'frontend',
      document_count: 3,
    })
    const organization = makeKnowledgeBase({
      id: 3,
      name: 'Org KB',
      namespace: 'org',
      document_count: 5,
    })

    const result = buildKnowledgeContextGroups({
      knowledgeBases: [group, organization, personal],
      boundKnowledgeBases: [],
      organizationNamespace: 'org',
      labels,
    })

    expect(result.scopes.map(scope => scope.key)).toEqual([
      'personal',
      'group:frontend',
      'organization',
    ])
    expect(result.optionsByScope.get('personal')?.map(option => option.name)).toEqual([
      'Personal KB',
    ])
    expect(result.optionsByScope.get('group:frontend')?.[0]).toMatchObject({
      name: 'Group KB',
      pathLabel: 'Group / frontend',
      documentCount: 3,
    })
    expect(result.optionsByScope.get('organization')?.[0]).toMatchObject({
      name: 'Org KB',
      pathLabel: 'Organization',
      documentCount: 5,
    })
  })

  it('excludes the current notebook knowledge base from selectable options', () => {
    const result = buildKnowledgeContextGroups({
      knowledgeBases: [
        makeKnowledgeBase({ id: 1, name: 'Current KB' }),
        makeKnowledgeBase({ id: 2, name: 'Other KB' }),
      ],
      boundKnowledgeBases: [],
      excludeKnowledgeBaseId: 1,
      labels,
    })

    expect(result.options.map(option => option.name)).toEqual(['Other KB'])
  })
})
