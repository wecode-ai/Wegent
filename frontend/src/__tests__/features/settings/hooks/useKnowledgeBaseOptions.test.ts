// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from '@testing-library/react'

import { knowledgeBaseApi } from '@/apis/knowledge-base'
import { useKnowledgeBaseOptions } from '@/features/settings/hooks/useKnowledgeBaseOptions'

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: {
    getAllGrouped: jest.fn(),
  },
}))

const mockedGetAllGrouped = knowledgeBaseApi.getAllGrouped as jest.Mock

describe('useKnowledgeBaseOptions', () => {
  beforeEach(() => {
    mockedGetAllGrouped.mockReset()
  })

  test('deduplicates knowledge bases returned in both group and organization sections', async () => {
    mockedGetAllGrouped.mockResolvedValue({
      personal: {
        created_by_me: [],
        shared_with_me: [],
      },
      groups: [
        {
          group_name: 'weibo',
          group_display_name: 'Weibo',
          kb_count: 1,
          knowledge_bases: [
            {
              id: 126,
              name: 'Weibo Docs',
              description: 'Duplicated org kb',
              kb_type: 'notebook',
              namespace: 'weibo',
              document_count: 3,
              updated_at: '2026-05-10T00:00:00Z',
              created_at: '2026-05-09T00:00:00Z',
              user_id: 1,
              group_id: 'weibo',
              group_name: 'Weibo',
              group_type: 'group',
            },
          ],
        },
      ],
      organization: {
        namespace: 'weibo',
        display_name: 'Weibo',
        kb_count: 1,
        knowledge_bases: [
          {
            id: 126,
            name: 'Weibo Docs',
            description: 'Duplicated org kb',
            kb_type: 'notebook',
            namespace: 'weibo',
            document_count: 3,
            updated_at: '2026-05-10T00:00:00Z',
            created_at: '2026-05-09T00:00:00Z',
            user_id: 1,
            group_id: 'weibo',
            group_name: 'Weibo',
            group_type: 'organization',
          },
        ],
      },
      summary: {
        total_count: 1,
        personal_count: 0,
        group_count: 0,
        organization_count: 1,
      },
    })

    const { result } = renderHook(() => useKnowledgeBaseOptions())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.options).toHaveLength(1)
    expect(result.current.options[0]).toMatchObject({
      id: 126,
      source: 'organization',
      namespace: 'weibo',
    })
  })
})
