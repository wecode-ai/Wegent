// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, renderHook, waitFor } from '@testing-library/react'

import { listDocuments } from '@/apis/knowledge'
import { useDocuments } from '@/features/knowledge/document/hooks/useDocuments'

jest.mock('@/hooks/useTranslation', () => {
  const t = (key: string) => key
  return {
    useTranslation: () => ({ t }),
  }
})

jest.mock('@/apis/knowledge', () => ({
  listDocuments: jest.fn(),
  createDocument: jest.fn(),
  updateDocument: jest.fn(),
  deleteDocument: jest.fn(),
  batchDeleteDocuments: jest.fn(),
  transferDocuments: jest.fn(),
}))

const mockListDocuments = listDocuments as jest.MockedFunction<typeof listDocuments>

function createDocument(id: number, name: string, overrides = {}) {
  return {
    id,
    kind_id: 1,
    attachment_id: null,
    name,
    file_extension: 'txt',
    file_size: 128,
    status: 'enabled' as const,
    user_id: 1,
    is_active: true,
    index_status: 'success' as const,
    index_generation: 1,
    source_type: 'file' as const,
    source_config: {},
    folder_id: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function createListResponse(id: number, name: string) {
  return createListResponseFromItems([createDocument(id, name)])
}

function createListResponseFromItems(
  items: Array<ReturnType<typeof createDocument>>,
  overrides: Partial<{
    total: number
    returned_count: number
    limit: number
    offset: number
    has_more: boolean
  }> = {}
) {
  return {
    items,
    total: items.length,
    returned_count: items.length,
    limit: 500,
    offset: 0,
    has_more: false,
    ...overrides,
  }
}

function deferredResponse(id: number, name: string) {
  let resolve!: (value: ReturnType<typeof createListResponse>) => void
  const promise = new Promise<ReturnType<typeof createListResponse>>(innerResolve => {
    resolve = innerResolve
  })
  return { promise, resolve: () => resolve(createListResponse(id, name)) }
}

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

  it('passes folder, search, sort, and pagination parameters in server fallback mode', async () => {
    mockListDocuments
      .mockResolvedValueOnce(
        createListResponseFromItems([], {
          total: 2001,
          returned_count: 0,
          has_more: true,
        })
      )
      .mockResolvedValueOnce(createListResponse(1, 'result.txt'))

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
        limit: 500,
        offset: 0,
      })
      expect(mockListDocuments).toHaveBeenCalledWith(1, {
        folder_id: 12,
        include_subfolders: true,
        keyword: 'yearly report',
        sort_by: 'name',
        sort_order: 'asc',
        limit: 100,
        offset: 0,
      })
    })
  })

  it('debounces keyword changes before applying local snapshot filtering', async () => {
    mockListDocuments.mockResolvedValue(
      createListResponseFromItems([createDocument(1, 'alpha.txt'), createDocument(2, 'abc.txt')])
    )

    const { result, rerender } = renderHook(
      ({ keyword }) =>
        useDocuments({
          knowledgeBaseId: 1,
          paginationEnabled: true,
          keyword,
        }),
      { initialProps: { keyword: '' } }
    )

    await waitFor(() => expect(mockListDocuments).toHaveBeenCalledTimes(1))
    mockListDocuments.mockClear()

    rerender({ keyword: 'a' })
    rerender({ keyword: 'ab' })
    rerender({ keyword: 'abc' })

    await new Promise(resolve => setTimeout(resolve, 100))
    expect(mockListDocuments).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(result.current.documents.map(doc => doc.name)).toEqual(['abc.txt'])
    })
    expect(mockListDocuments).not.toHaveBeenCalled()
  })

  it('ignores stale responses after query changes', async () => {
    const requestsByKeyword = new Map<string, Array<ReturnType<typeof deferredResponse>>>()
    mockListDocuments.mockImplementation((_knowledgeBaseId, params) => {
      if (!params?.keyword) {
        return Promise.resolve(
          createListResponseFromItems([], {
            total: 2001,
            returned_count: 0,
            has_more: true,
          })
        )
      }

      const keyword = params?.keyword ?? ''
      const request = deferredResponse(
        keyword === 'new' ? 2 : 1,
        keyword === 'new' ? 'new.txt' : 'old.txt'
      )
      requestsByKeyword.set(keyword, [...(requestsByKeyword.get(keyword) ?? []), request])
      return request.promise
    })

    const { result, rerender } = renderHook(
      ({ keyword }) =>
        useDocuments({
          knowledgeBaseId: 1,
          paginationEnabled: true,
          keyword,
        }),
      { initialProps: { keyword: 'old' } }
    )

    await waitFor(() => expect(requestsByKeyword.get('old')?.length).toBeGreaterThan(0))

    rerender({ keyword: 'new' })

    await waitFor(() => expect(requestsByKeyword.get('new')?.length).toBeGreaterThan(0))

    await act(async () => {
      const newRequest = requestsByKeyword.get('new')!.at(-1)!
      newRequest.resolve()
      await newRequest.promise
    })

    await waitFor(() => {
      expect(result.current.documents.map(doc => doc.name)).toEqual(['new.txt'])
    })

    await act(async () => {
      const oldRequests = requestsByKeyword.get('old') ?? []
      oldRequests.forEach(request => request.resolve())
      await Promise.all(oldRequests.map(request => request.promise))
    })

    expect(result.current.documents.map(doc => doc.name)).toEqual(['new.txt'])
  })

  it('uses the same fixed id-desc tie-break as the server in local mode', async () => {
    mockListDocuments.mockResolvedValue(
      createListResponseFromItems([createDocument(1, 'same.txt'), createDocument(2, 'same.txt')])
    )

    const { result } = renderHook(() =>
      useDocuments({
        knowledgeBaseId: 1,
        paginationEnabled: true,
        sortBy: 'name',
        sortOrder: 'asc',
      })
    )

    await waitFor(() => {
      expect(result.current.documents.map(doc => doc.id)).toEqual([2, 1])
    })
  })
})
