// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { renderHook, waitFor } from '@testing-library/react'

import { listDocuments } from '@/apis/knowledge'
import { useDocuments } from '@/features/knowledge/document/hooks/useDocuments'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/apis/knowledge', () => ({
  listDocuments: jest.fn(),
  createDocument: jest.fn(),
  updateDocument: jest.fn(),
  deleteDocument: jest.fn(),
  batchDeleteDocuments: jest.fn(),
  transferDocuments: jest.fn(),
}))

const mockListDocuments = listDocuments as jest.MockedFunction<typeof listDocuments>

describe('useDocuments query parameters', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListDocuments.mockResolvedValue({
      items: [],
      total: 0,
      returned_count: 0,
      limit: 50,
      offset: 0,
      has_more: false,
    })
  })

  it('passes folder, search, sort, and pagination parameters to listDocuments', async () => {
    renderHook(() =>
      useDocuments({
        knowledgeBaseId: 1,
        paginationEnabled: true,
        folderId: 12,
        includeSubfolders: true,
        keyword: '  yearly report  ',
        sortBy: 'name',
        sortOrder: 'asc',
      })
    )

    await waitFor(() => {
      expect(mockListDocuments).toHaveBeenCalledWith(1, {
        folder_id: 12,
        include_subfolders: true,
        keyword: 'yearly report',
        sort_by: 'name',
        sort_order: 'asc',
        limit: 50,
        offset: 0,
      })
    })
  })
})
