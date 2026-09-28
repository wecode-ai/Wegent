// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from '@testing-library/react'

import { useKnowledgeSidebar } from '@/features/knowledge/document/hooks/useKnowledgeSidebar'
import type { AllGroupedKnowledgeResponse } from '@/types/knowledge'

const mockGetAllGrouped = jest.fn()

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: {
    getAllGrouped: () => mockGetAllGrouped(),
  },
}))

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBase: jest.fn(),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: 1 } }),
}))

describe('useKnowledgeSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    mockGetAllGrouped.mockReset()
  })

  it('counts group knowledge bases by internal group id rather than display name', async () => {
    const response: AllGroupedKnowledgeResponse = {
      personal: { created_by_me: [], shared_with_me: [] },
      groups: [
        {
          group_name: 'engineering',
          group_display_name: 'Engineering Team',
          kb_count: 1,
          knowledge_bases: [
            {
              id: 1,
              name: 'Architecture',
              description: null,
              kb_type: 'notebook',
              namespace: 'engineering',
              document_count: 0,
              updated_at: '2026-09-22T00:00:00Z',
              created_at: '2026-09-22T00:00:00Z',
              user_id: 1,
              group_id: 'engineering',
              group_name: 'Engineering Team',
              group_type: 'group',
            },
          ],
        },
      ],
      organization: {
        namespace: 'organization',
        display_name: 'Organization',
        kb_count: 0,
        knowledge_bases: [],
      },
      summary: {
        total_count: 1,
        personal_count: 0,
        group_count: 1,
        organization_count: 0,
      },
    }
    mockGetAllGrouped.mockResolvedValue(response)

    const { result } = renderHook(() => useKnowledgeSidebar())

    await waitFor(() => expect(result.current.isGroupsLoading).toBe(false))

    expect(result.current.groups.find(group => group.id === 'group-engineering')?.kbCount).toBe(1)
  })
})
