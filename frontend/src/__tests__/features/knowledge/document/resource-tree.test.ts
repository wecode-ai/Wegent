// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildKnowledgeResourceTree,
  collectFolderAndAncestorIds,
  collectFolderAndDescendantIds,
  flattenKnowledgeResourceRows,
  getResultDocumentFolderKeys,
} from '@/features/knowledge/document/utils/resource-tree'
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
    total_document_count: 1,
    children: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('knowledge resource tree', () => {
  it('builds one resource tree that keeps folders, root documents, and orphan documents', () => {
    const folders = [createFolder()]
    const { nodes } = buildKnowledgeResourceTree(folders, [
      createDocument({ id: 11, name: 'inside.txt', folder_id: 1 }),
      createDocument({ id: 12, name: 'root.txt', folder_id: 0 }),
      createDocument({ id: 13, name: 'orphan.txt', folder_id: 999 }),
    ])

    expect(nodes.map(node => node.key)).toEqual(['folder:1', 'document:12', 'document:13'])
    expect(nodes[0].kind).toBe('folder')
    if (nodes[0].kind === 'folder') {
      expect(nodes[0].children.map(node => node.key)).toEqual(['document:11'])
    }
  })

  it('records loaded document count separately from folder total count', () => {
    const folders = [
      createFolder({
        document_count: 1,
        direct_document_count: 1,
        total_document_count: 3,
      }),
    ]
    const { nodes } = buildKnowledgeResourceTree(folders, [
      createDocument({ id: 11, folder_id: 1 }),
    ])

    const folderNode = nodes[0]
    expect(folderNode.kind).toBe('folder')
    if (folderNode.kind === 'folder') {
      expect(folderNode.documentCount).toBe(3)
      expect(folderNode.loadedDocumentCount).toBe(1)
      expect(folderNode.hasUnloadedDocuments).toBe(true)
    }
  })

  it('flattens only expanded folder children into visible rows', () => {
    const { nodes } = buildKnowledgeResourceTree(
      [createFolder()],
      [createDocument({ id: 11, folder_id: 1 })]
    )

    expect(flattenKnowledgeResourceRows(nodes, new Set()).map(row => row.node.key)).toEqual([
      'folder:1',
    ])
    expect(
      flattenKnowledgeResourceRows(nodes, new Set(['folder:1'])).map(row => row.node.key)
    ).toEqual(['folder:1', 'document:11'])
  })

  it('indexes folder ancestors, descendants, and result document paths', () => {
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
    const { index } = buildKnowledgeResourceTree(folders, [])

    expect(Array.from(collectFolderAndDescendantIds(folders, 1))).toEqual([1, 2])
    expect(Array.from(collectFolderAndAncestorIds(folders, 2))).toEqual([1, 2])
    expect(
      Array.from(getResultDocumentFolderKeys(index, [createDocument({ id: 11, folder_id: 2 })]))
    ).toEqual(['folder:1', 'folder:2'])
  })
})
