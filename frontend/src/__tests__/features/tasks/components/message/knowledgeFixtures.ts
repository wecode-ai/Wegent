// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeBaseWithGroupInfo, MemberRole } from '@/types/knowledge'

export function knowledgeBase(
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
