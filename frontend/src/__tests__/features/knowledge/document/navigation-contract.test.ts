// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { collectNavigationKnowledge } from '@/features/knowledge/document/navigation'
import { matchesKnowledgeOwnershipFilter } from '@/features/knowledge/document/library-level'
import type { AllGroupedKnowledgeResponse, KnowledgeBaseWithGroupInfo } from '@/types/knowledge'

const row = (id: number, namespace: string): KnowledgeBaseWithGroupInfo => ({
  id,
  name: `Library ${id}`,
  description: null,
  namespace,
  user_id: 1,
  kb_type: 'notebook',
  group_id: 'default',
  group_name: 'personal-shared',
  group_type: 'personal-shared',
  my_role: 'Reporter',
  document_count: 0,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
})
const source = {
  ...row(2, 'source'),
  group_id: 'source',
  group_name: 'Source team',
  group_type: 'group' as const,
  my_role: 'Developer' as const,
}
const personal = {
  ...row(1, 'default'),
  group_type: 'personal' as const,
  my_role: 'Owner' as const,
}
const response: AllGroupedKnowledgeResponse = {
  personal: { created_by_me: [personal], shared_with_me: [row(5, 'not-in-directory')] },
  groups: [
    {
      group_name: 'source',
      group_display_name: 'Source team',
      kb_count: 1,
      knowledge_bases: [source],
    },
    {
      group_name: 'receiving',
      group_display_name: 'Receiver',
      kb_count: 2,
      knowledge_bases: [
        { ...source, group_id: 'receiving', group_name: 'Receiver', my_role: 'Reporter' },
        { ...personal, group_id: 'receiving', group_name: 'Receiver', group_type: 'group' },
      ],
    },
  ],
  organization: {
    namespace: 'company',
    display_name: 'Company',
    kb_count: 1,
    knowledge_bases: [
      {
        ...row(3, 'company'),
        group_type: 'organization',
        group_id: 'company',
        group_name: 'Company',
      },
    ],
  },
  summary: { total_count: 4, personal_count: 1, group_count: 2, organization_count: 1 },
}

it('derives real namespaces without mutating the grouped contract or merging permissions', () => {
  const before = JSON.stringify(response)
  const rows = collectNavigationKnowledge(response)
  expect(rows).toHaveLength(4)
  expect(rows.find(kb => kb.id === 2)).toMatchObject({
    namespace: 'source',
    namespace_level: 'group',
    namespace_display_name: 'Source team',
    my_role: 'Developer',
    effective_role: null,
  })
  expect(rows.find(kb => kb.id === 1)).toMatchObject({
    namespace: 'default',
    namespace_level: 'personal',
    effective_role: null,
  })
  expect(rows.find(kb => kb.id === 3)).toMatchObject({
    namespace: 'company',
    namespace_level: 'organization',
  })
  expect(rows.find(kb => kb.id === 5)).toMatchObject({
    namespace: 'not-in-directory',
    namespace_level: null,
    namespace_display_name: null,
  })
  expect(JSON.stringify(response)).toBe(before)
  expect(
    collectNavigationKnowledge({ ...response, groups: [...response.groups].reverse() })
  ).toEqual(rows)
})

it('separates actual ownership from receiving teams and leaves unresolved namespaces unknown', () => {
  const rows = collectNavigationKnowledge(response)
  const ids = (filter: string) =>
    rows
      .filter(kb => matchesKnowledgeOwnershipFilter(kb, filter))
      .map(kb => kb.id)
      .sort()
  expect(ids('personal')).toEqual([1])
  expect(ids('organization')).toEqual([2])
  expect(ids('company')).toEqual([3])
  expect(ids('unknown')).toEqual([5])
  expect(ids('group-receiving')).toEqual([])
  expect(ids('group-not-in-directory')).toEqual([])
  expect(rows.every(kb => kb.effective_role === null)).toBe(true)
})

it('changes owning-space classification only when the library actually moves', () => {
  const migrated = {
    ...response,
    personal: { ...response.personal, created_by_me: [{ ...personal, namespace: 'source' }] },
    groups: response.groups.map(group => ({
      ...group,
      knowledge_bases: group.knowledge_bases.map(kb =>
        kb.id === personal.id ? { ...kb, namespace: 'source' } : kb
      ),
    })),
  }
  const row = collectNavigationKnowledge(migrated).find(kb => kb.id === personal.id)!
  expect(matchesKnowledgeOwnershipFilter(row, 'organization')).toBe(true)
  expect(matchesKnowledgeOwnershipFilter(row, 'group-source')).toBe(true)
  expect(matchesKnowledgeOwnershipFilter(row, 'personal')).toBe(false)
})
