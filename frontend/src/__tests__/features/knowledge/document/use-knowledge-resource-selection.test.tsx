// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'

import { useKnowledgeResourceSelection } from '@/features/knowledge/document/hooks/useKnowledgeResourceSelection'
import { buildKnowledgeResourceTree } from '@/features/knowledge/document/utils/resource-tree'
import type { KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'

function createDocument(overrides?: Partial<KnowledgeDocument>): KnowledgeDocument {
  return {
    id: 10,
    kind_id: 1,
    user_id: 1,
    name: 'doc.txt',
    file_extension: 'txt',
    file_size: 128,
    status: 'enabled',
    is_active: true,
    index_status: 'success',
    index_generation: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    folder_id: 0,
    source_type: 'file',
    source_config: {},
    attachment_id: null,
    created_by: 'alice',
    ...overrides,
  }
}

function createFolder(overrides?: Partial<KnowledgeFolder>): KnowledgeFolder {
  return {
    id: 1,
    kind_id: 1,
    parent_id: 0,
    name: 'Reports',
    document_count: 1,
    direct_document_count: 1,
    total_document_count: 2,
    children: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('useKnowledgeResourceSelection', () => {
  it('keeps folder selection as backend-resolved scope instead of expanding current-page documents', () => {
    const documents = [createDocument({ id: 11, folder_id: 1 })]
    const { index } = buildKnowledgeResourceTree([createFolder()], documents)
    const { result } = renderHook(() =>
      useKnowledgeResourceSelection({
        documents,
        treeIndex: index,
      })
    )

    act(() => {
      result.current.selectFolderScope(1, true)
    })

    expect(result.current.selectedFolderIds).toEqual(new Set([1]))
    expect(result.current.selectedDocumentIds).toEqual(new Set())
    expect(result.current.getPayload()).toEqual({ folderIds: [1], documentIds: [] })
    expect(result.current.summary.canTransfer).toBe(true)
    expect(result.current.summary.canMoveDocuments).toBe(false)
    expect(result.current.summary.canDeleteDocuments).toBe(false)
  })

  it('clears folder scope when current visible documents are selected from the header', () => {
    const documents = [createDocument({ id: 11, folder_id: 1 })]
    const { index } = buildKnowledgeResourceTree([createFolder()], documents)
    const { result } = renderHook(() =>
      useKnowledgeResourceSelection({
        documents,
        treeIndex: index,
      })
    )

    act(() => {
      result.current.selectFolderScope(1, true)
      result.current.selectVisibleDocuments(true)
    })

    expect(result.current.selectedFolderIds).toEqual(new Set())
    expect(result.current.selectedDocumentIds).toEqual(new Set([11]))
    expect(result.current.summary.canMoveDocuments).toBe(true)
    expect(result.current.summary.canDeleteDocuments).toBe(true)
  })

  it('removes selected ancestor folders when a descendant document is explicitly deselected', () => {
    const documents = [createDocument({ id: 11, folder_id: 2 })]
    const folders = [
      createFolder({
        children: [
          createFolder({
            id: 2,
            parent_id: 1,
            name: 'Child',
          }),
        ],
      }),
    ]
    const { index } = buildKnowledgeResourceTree(folders, documents)
    const { result } = renderHook(() =>
      useKnowledgeResourceSelection({
        documents,
        treeIndex: index,
      })
    )

    act(() => {
      result.current.selectFolderScope(1, true)
      result.current.selectDocument(documents[0], false)
    })

    expect(result.current.selectedFolderIds).toEqual(new Set())
    expect(result.current.isDocumentIncludedInFolderScope(documents[0])).toBe(false)
  })
})
