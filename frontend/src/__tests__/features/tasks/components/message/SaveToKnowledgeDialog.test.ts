// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getWritableKnowledgeBases } from '@/features/tasks/components/message/SaveToKnowledgeDialog'
import type {
  AllGroupedKnowledgeResponse,
  KnowledgeBaseWithGroupInfo,
  MemberRole,
} from '@/types/knowledge'

function knowledgeBase(
  id: number,
  role: MemberRole,
  overrides: Partial<KnowledgeBaseWithGroupInfo> = {}
): KnowledgeBaseWithGroupInfo {
  return {
    id,
    name: `kb-${id}`,
    description: null,
    kb_type: 'notebook',
    namespace: 'default',
    document_count: 0,
    updated_at: '2026-07-26T00:00:00Z',
    created_at: '2026-07-26T00:00:00Z',
    user_id: 99,
    group_id: 'default',
    group_name: 'personal',
    group_type: 'personal-shared',
    my_role: role,
    ...overrides,
  }
}

describe('getWritableKnowledgeBases', () => {
  it('keeps creators and editor roles while excluding read-only roles and duplicates', () => {
    const data: AllGroupedKnowledgeResponse = {
      personal: {
        created_by_me: [
          knowledgeBase(1, 'Reporter', {
            user_id: 7,
            group_type: 'personal',
          }),
        ],
        shared_with_me: [knowledgeBase(2, 'Developer'), knowledgeBase(3, 'Reporter')],
      },
      groups: [
        {
          group_name: 'engineering',
          group_display_name: 'Engineering',
          kb_count: 2,
          knowledge_bases: [
            knowledgeBase(4, 'Maintainer', {
              namespace: 'engineering',
              group_type: 'group',
            }),
            knowledgeBase(2, 'Developer'),
          ],
        },
      ],
      organization: {
        namespace: 'organization',
        display_name: 'Organization',
        kb_count: 1,
        knowledge_bases: [
          knowledgeBase(5, 'RestrictedAnalyst', {
            namespace: 'organization',
            group_type: 'organization',
          }),
        ],
      },
      summary: {
        total_count: 5,
        personal_count: 3,
        group_count: 1,
        organization_count: 1,
      },
    }

    const options = getWritableKnowledgeBases(data, 7, kb => kb.group_name)

    expect(options.map(option => option.knowledgeBase.id)).toEqual([1, 2, 4])
  })

  it('keeps a later writable representation when a read-only duplicate appears first', () => {
    const readOnly = knowledgeBase(7, 'Reporter')
    const writable = knowledgeBase(7, 'Developer', {
      namespace: 'engineering',
      group_id: 'engineering',
      group_name: 'engineering',
      group_type: 'group',
    })
    const data: AllGroupedKnowledgeResponse = {
      personal: {
        created_by_me: [],
        shared_with_me: [readOnly],
      },
      groups: [
        {
          group_name: 'engineering',
          group_display_name: 'Engineering',
          kb_count: 1,
          knowledge_bases: [writable],
        },
      ],
      organization: {
        namespace: null,
        display_name: 'Organization',
        kb_count: 0,
        knowledge_bases: [],
      },
      summary: {
        total_count: 1,
        personal_count: 1,
        group_count: 1,
        organization_count: 0,
      },
    }

    const options = getWritableKnowledgeBases(data, 1, kb => kb.group_name)

    expect(options).toHaveLength(1)
    expect(options[0].knowledgeBase).toBe(writable)
  })
})
