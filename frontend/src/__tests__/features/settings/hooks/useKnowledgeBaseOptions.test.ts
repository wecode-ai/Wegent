// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'

import { getKnowledgeCatalogPage, type KnowledgeCatalogPage } from '@/apis/knowledge'
import { knowledgeBaseApi } from '@/apis/knowledge-base'
import {
  useKnowledgeBaseOptions,
  useKnowledgeBindingValidation,
} from '@/features/settings/hooks/useKnowledgeBaseOptions'

jest.mock('@/apis/knowledge', () => ({ getKnowledgeCatalogPage: jest.fn() }))
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

test('blocks save until the bindings are revalidated after reopening', async () => {
  const emptyPage: KnowledgeCatalogPage = {
    items: [],
    total: 0,
    returned_count: 0,
    limit: 50,
    offset: 0,
    has_more: false,
    space_counts: {},
  }
  const readyPage: KnowledgeCatalogPage = {
    ...emptyPage,
    items: [
      {
        id: 126,
        name: 'Team Docs',
        description: null,
        user_id: 1,
        namespace: 'team',
        document_count: 0,
        kb_type: 'classic',
        created_at: '2026-11-25T00:00:00Z',
        updated_at: '2026-11-25T00:00:00Z',
        namespace_level: 'group',
        namespace_display_name: 'Team',
      },
    ],
    total: 1,
    returned_count: 1,
  }
  let complete!: (page: KnowledgeCatalogPage) => void
  jest
    .mocked(getKnowledgeCatalogPage)
    .mockResolvedValueOnce(readyPage)
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
  const { result, rerender } = renderHook(
    ({ open }) => useKnowledgeBindingValidation([126], open ? 1 : undefined, 'team', false),
    { initialProps: { open: true } }
  )
  await waitFor(() => expect(result.current.blocksSave).toBe(false))
  rerender({ open: false })
  rerender({ open: true })
  expect(result.current).toMatchObject({ status: 'pending', blocksSave: true })
  await act(async () => complete(emptyPage))
  expect(result.current).toMatchObject({ status: 'ready', blocksSave: true })
  expect(result.current.invalidIds.has(126)).toBe(true)
})
