// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { listDocuments } from '@/apis/knowledge'
import { findDocumentByName } from '@/features/knowledge/document/utils/document-lookup'
import type { KnowledgeDocument } from '@/types/knowledge'

jest.mock('@/apis/knowledge', () => ({
  listDocuments: jest.fn(),
}))

const mockListDocuments = listDocuments as jest.MockedFunction<typeof listDocuments>

const createDocument = (id: number, name: string) =>
  ({
    id,
    name,
  }) as KnowledgeDocument

describe('findDocumentByName', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('finds a document beyond the first result page', async () => {
    const target = createDocument(2, 'target.md')
    mockListDocuments
      .mockResolvedValueOnce({
        items: [createDocument(1, 'first.md')],
        total: 2,
        returned_count: 1,
        limit: 200,
        offset: 0,
        has_more: true,
      })
      .mockResolvedValueOnce({
        items: [target],
        total: 2,
        returned_count: 1,
        limit: 200,
        offset: 1,
        has_more: false,
      })

    await expect(findDocumentByName(12, 'target.md')).resolves.toBe(target)
    expect(mockListDocuments).toHaveBeenNthCalledWith(2, 12, {
      limit: 200,
      offset: 1,
    })
  })

  it('stops before making a request when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(findDocumentByName(12, 'target.md', controller.signal)).resolves.toBeUndefined()
    expect(mockListDocuments).not.toHaveBeenCalled()
  })
})
