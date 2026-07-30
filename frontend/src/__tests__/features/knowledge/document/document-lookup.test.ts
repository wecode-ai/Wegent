// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getDocumentContent, listDocuments } from '@/apis/knowledge'
import {
  findDocumentByName,
  findDocumentForDeepLink,
} from '@/features/knowledge/document/utils/document-lookup'
import type { KnowledgeDocument } from '@/types/knowledge'

jest.mock('@/apis/knowledge', () => ({
  getDocumentContent: jest.fn(),
  listDocuments: jest.fn(),
}))

const mockGetDocumentContent = getDocumentContent as jest.MockedFunction<typeof getDocumentContent>
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

describe('findDocumentForDeepLink', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses the document ID as the source of truth when names are duplicated', async () => {
    const target = createDocument(2, 'guide.md')
    mockGetDocumentContent.mockResolvedValue({
      document_id: 2,
      name: 'guide.md',
      content: '',
      total_length: 0,
      offset: 0,
      returned_length: 0,
      has_more: false,
      kb_id: 12,
      index_status: 'success',
    })
    mockListDocuments.mockResolvedValue({
      items: [createDocument(1, 'guide.md'), target],
      total: 2,
      returned_count: 2,
      limit: 200,
      offset: 0,
      has_more: false,
    })

    await expect(findDocumentForDeepLink(12, 'guide.md', 2)).resolves.toBe(target)
    expect(mockListDocuments).toHaveBeenCalledWith(12, {
      keyword: 'guide.md',
      limit: 200,
      offset: 0,
    })
  })

  it('resolves a renamed document from its current server identity', async () => {
    const target = createDocument(2, 'renamed.md')
    mockGetDocumentContent.mockResolvedValue({
      document_id: 2,
      name: 'renamed.md',
      content: '',
      total_length: 0,
      offset: 0,
      returned_length: 0,
      has_more: false,
      kb_id: 12,
      index_status: 'success',
    })
    mockListDocuments.mockResolvedValue({
      items: [target],
      total: 1,
      returned_count: 1,
      limit: 200,
      offset: 0,
      has_more: false,
    })

    await expect(findDocumentForDeepLink(12, 'old-name.md', 2)).resolves.toBe(target)
    expect(mockListDocuments).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ keyword: 'renamed.md' })
    )
  })

  it('keeps legacy name-only links working', async () => {
    const target = createDocument(2, 'guide.md')
    mockListDocuments.mockResolvedValue({
      items: [target],
      total: 1,
      returned_count: 1,
      limit: 200,
      offset: 0,
      has_more: false,
    })

    await expect(findDocumentForDeepLink(12, 'guide.md')).resolves.toBe(target)
    expect(mockGetDocumentContent).not.toHaveBeenCalled()
  })

  it('rejects a document ID from another knowledge base', async () => {
    mockGetDocumentContent.mockResolvedValue({
      document_id: 2,
      name: 'guide.md',
      content: '',
      total_length: 0,
      offset: 0,
      returned_length: 0,
      has_more: false,
      kb_id: 99,
      index_status: 'success',
    })

    await expect(findDocumentForDeepLink(12, 'guide.md', 2)).resolves.toBeUndefined()
    expect(mockListDocuments).not.toHaveBeenCalled()
  })
})
