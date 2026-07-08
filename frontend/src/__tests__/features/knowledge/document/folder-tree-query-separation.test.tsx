// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  DocumentItem,
  getDocumentTableGridTemplate,
} from '@/features/knowledge/document/components/DocumentItem'
import { FolderTree } from '@/features/knowledge/document/components/FolderTree'
import {
  deletedFolderAffectsActiveFolder,
  folderTreeContainsId,
  shouldDisableDocumentBatchActions,
} from '@/features/knowledge/document/components/DocumentList'
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
    total_document_count: 3,
    children: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('FolderTree query/result separation', () => {
  it('selects folder scope without selecting current-page documents', () => {
    const onSelectFolder = jest.fn()
    const onSelectDocument = jest.fn()

    render(
      <FolderTree
        folders={[createFolder()]}
        documents={[createDocument({ id: 11, folder_id: 1 })]}
        canSelectFolders={true}
        selectedFolderIds={new Set()}
        onSelectFolder={onSelectFolder}
        selectedIds={new Set()}
        onSelect={onSelectDocument}
        canSelect={() => true}
      />
    )

    fireEvent.click(screen.getByTestId('folder-checkbox-1'))

    expect(onSelectFolder).toHaveBeenCalledWith(1, true)
    expect(onSelectDocument).not.toHaveBeenCalled()
  })

  it('keeps slash-containing document names as plain file names', () => {
    render(
      <FolderTree folders={[]} documents={[createDocument({ id: 12, name: 'legacy/path.txt' })]} />
    )

    expect(screen.getByText('legacy/path.txt')).toBeInTheDocument()
    expect(screen.queryByText('document.folder.docCount:1')).not.toBeInTheDocument()
  })
})

describe('DocumentItem table grid', () => {
  it('uses the shared grid column template in table mode', () => {
    const template = getDocumentTableGridTemplate({
      showSelectionColumn: true,
      showActionsColumn: true,
      nameColumnWidth: 320,
    })

    render(
      <DocumentItem
        document={createDocument()}
        canSelect={true}
        onSelect={jest.fn()}
        canManage={true}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        compact={false}
        nameColumnWidth={320}
      />
    )

    const row = screen.getByText('doc.txt').closest('.grid')
    expect(row).toHaveStyle({ gridTemplateColumns: template })
  })

  it('does not reserve the action column in readonly table mode', () => {
    const template = getDocumentTableGridTemplate({
      showSelectionColumn: false,
      showActionsColumn: false,
    })

    render(
      <FolderTree
        folders={[]}
        documents={[createDocument()]}
        compact={false}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        onMove={jest.fn()}
        canManage={() => false}
        showActionsColumn={false}
      />
    )

    const row = screen.getByText('doc.txt').closest('.grid')
    expect(row).toHaveStyle({ gridTemplateColumns: template })
  })
})

describe('DocumentList folder navigation guard helpers', () => {
  const folderTree = [
    createFolder({
      id: 1,
      children: [
        createFolder({
          id: 2,
          parent_id: 1,
          children: [],
        }),
      ],
    }),
  ]

  it('detects deleted active folders and deleted ancestors', () => {
    expect(deletedFolderAffectsActiveFolder(folderTree, 2, 2)).toBe(true)
    expect(deletedFolderAffectsActiveFolder(folderTree, 1, 2)).toBe(true)
    expect(deletedFolderAffectsActiveFolder(folderTree, 2, 1)).toBe(false)
  })

  it('detects stale active folders after folder tree refresh', () => {
    expect(folderTreeContainsId(folderTree, 2)).toBe(true)
    expect(folderTreeContainsId(folderTree, 99)).toBe(false)
    expect(folderTreeContainsId(folderTree, undefined)).toBe(true)
  })

  it('disables document batch actions whenever folder scope is selected', () => {
    expect(
      shouldDisableDocumentBatchActions({
        selectedDocumentCount: 1,
        selectedFolderCount: 1,
      })
    ).toBe(true)
    expect(
      shouldDisableDocumentBatchActions({
        selectedDocumentCount: 1,
        selectedFolderCount: 0,
      })
    ).toBe(false)
  })
})
