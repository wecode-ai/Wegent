// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { KnowledgeDocumentTreeGrid } from '@/features/knowledge/document/components/KnowledgeDocumentTreeGrid'
import { getDocumentTableGridTemplate } from '@/features/knowledge/document/components/DocumentItem'
import { buildKnowledgeResourceTree } from '@/features/knowledge/document/utils/resource-tree'
import type { KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, number>) =>
      params?.count !== undefined ? `${key}:${params.count}` : key,
  }),
}))

jest.mock('@/apis/attachments', () => ({
  downloadAttachment: jest.fn(),
}))

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

describe('KnowledgeDocumentTreeGrid', () => {
  it('renders folders and documents through visible TreeGrid rows', () => {
    const folders = [createFolder()]
    const documents = [createDocument({ id: 11, name: 'inside-folder.txt', folder_id: 1 })]
    const { nodes, index } = buildKnowledgeResourceTree(folders, documents)

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={documents}
        gridTemplateColumns={getDocumentTableGridTemplate({
          showSelectionColumn: true,
          showActionsColumn: true,
        })}
        showSelectionColumn={true}
        showActionsColumn={true}
        canSelectFolders={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )

    expect(screen.getByText('Reports')).toBeInTheDocument()
    expect(screen.getByText('inside-folder.txt')).toBeInTheDocument()
  })

  it('selects folder scope without selecting document rows', () => {
    const onSelectFolder = jest.fn()
    const onSelectDocument = jest.fn()
    const folders = [createFolder()]
    const documents = [createDocument({ id: 11, name: 'inside-folder.txt', folder_id: 1 })]
    const { nodes, index } = buildKnowledgeResourceTree(folders, documents)

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={documents}
        gridTemplateColumns={getDocumentTableGridTemplate({
          showSelectionColumn: true,
          showActionsColumn: true,
        })}
        showSelectionColumn={true}
        showActionsColumn={true}
        canSelectFolders={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
        onSelectFolder={onSelectFolder}
        canSelect={() => true}
        onSelect={onSelectDocument}
      />
    )

    fireEvent.click(screen.getByTestId('folder-checkbox-1'))

    expect(onSelectFolder).toHaveBeenCalledWith(1, true)
    expect(onSelectDocument).not.toHaveBeenCalled()
  })

  it('activates folder rows without coupling activation to expand controls', () => {
    const onActivateFolder = jest.fn()
    const folders = [createFolder()]
    const documents = [createDocument({ id: 11, name: 'inside-folder.txt', folder_id: 1 })]
    const { nodes, index } = buildKnowledgeResourceTree(folders, documents)

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={documents}
        gridTemplateColumns={getDocumentTableGridTemplate({
          showSelectionColumn: true,
          showActionsColumn: true,
        })}
        showSelectionColumn={true}
        showActionsColumn={true}
        canSelectFolders={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
        onActivateFolder={onActivateFolder}
      />
    )

    fireEvent.click(screen.getByLabelText('document.folder.collapse'))

    expect(screen.queryByText('inside-folder.txt')).not.toBeInTheDocument()
    expect(onActivateFolder).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Reports/ }))

    expect(onActivateFolder).toHaveBeenCalledWith(1)
  })
})
