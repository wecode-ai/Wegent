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

  it('marks folder-covered documents as included and prevents duplicate document selection', () => {
    const onSelectDocument = jest.fn()
    const document = createDocument({ id: 11, folder_id: 1 })

    render(
      <FolderTree
        folders={[createFolder()]}
        documents={[document]}
        canSelectFolders={true}
        selectedFolderIds={new Set([1])}
        selectedIds={new Set()}
        includedInFolderScope={doc => doc.folder_id === 1}
        onSelect={onSelectDocument}
        canSelect={() => true}
      />
    )

    const documentCheckbox = screen.getAllByRole('checkbox')[1]
    expect(documentCheckbox).toBeChecked()
    expect(documentCheckbox).toBeDisabled()

    fireEvent.click(documentCheckbox)

    expect(onSelectDocument).not.toHaveBeenCalled()
  })

  it('marks child folders covered by a selected parent folder as included and disabled', () => {
    const onSelectFolder = jest.fn()
    const folder = createFolder({
      children: [
        createFolder({
          id: 2,
          parent_id: 1,
          name: 'Child',
          document_count: 1,
          direct_document_count: 1,
          total_document_count: 1,
        }),
      ],
    })

    render(
      <FolderTree
        folders={[folder]}
        documents={[createDocument({ id: 11, folder_id: 2 })]}
        canSelectFolders={true}
        selectedFolderIds={new Set([1])}
        onSelectFolder={onSelectFolder}
      />
    )

    const childCheckbox = screen.getByTestId('folder-checkbox-2')
    expect(childCheckbox).toBeChecked()
    expect(childCheckbox).toBeDisabled()

    fireEvent.click(childCheckbox)

    expect(onSelectFolder).not.toHaveBeenCalledWith(2, true)
  })

  it('renders documents under their API folder nodes', () => {
    render(
      <FolderTree
        folders={[createFolder()]}
        documents={[
          createDocument({ id: 11, name: 'inside-folder.txt', folder_id: 1 }),
          createDocument({ id: 12, name: 'root.txt', folder_id: 0 }),
        ]}
      />
    )

    const folderRow = screen.getByText('Reports').closest('div')
    const folderContainer = folderRow?.parentElement

    expect(screen.queryByRole('button', { name: /Reports/ })).not.toBeInTheDocument()
    expect(folderContainer).toHaveTextContent('inside-folder.txt')
    expect(folderContainer).not.toHaveTextContent('root.txt')
  })

  it('expands active folders so scoped documents remain visible', () => {
    const folder = createFolder({
      total_document_count: 1,
      children: [
        createFolder({
          id: 2,
          parent_id: 1,
          name: 'Child',
          document_count: 1,
          direct_document_count: 1,
          total_document_count: 1,
        }),
      ],
    })
    const documents = [createDocument({ id: 11, name: 'child-doc.txt', folder_id: 2 })]
    const { rerender } = render(<FolderTree folders={[folder]} documents={documents} />)

    fireEvent.click(screen.getByText('Reports').closest('div')!.querySelector('svg')!)
    expect(screen.queryByText('child-doc.txt')).not.toBeInTheDocument()

    rerender(<FolderTree folders={[folder]} documents={documents} activeFolderId={2} />)

    expect(screen.getByText('child-doc.txt')).toBeInTheDocument()
  })

  it('expands current result document paths even when nested folders default collapsed', () => {
    const folder = createFolder({
      total_document_count: 1,
      children: [
        createFolder({
          id: 2,
          parent_id: 1,
          name: 'Child',
          document_count: 0,
          direct_document_count: 0,
          total_document_count: 1,
          children: [
            createFolder({
              id: 3,
              parent_id: 2,
              name: 'Grandchild',
              document_count: 1,
              direct_document_count: 1,
              total_document_count: 1,
            }),
          ],
        }),
      ],
    })

    render(
      <FolderTree
        folders={[folder]}
        documents={[createDocument({ id: 11, name: 'nested-result.txt', folder_id: 3 })]}
      />
    )

    expect(screen.getByText('nested-result.txt')).toBeInTheDocument()
  })

  it('keeps slash-containing document names as plain file names', () => {
    render(
      <FolderTree folders={[]} documents={[createDocument({ id: 12, name: 'legacy/path.txt' })]} />
    )

    expect(screen.getByText('legacy/path.txt')).toBeInTheDocument()
    expect(screen.queryByText('document.folder.docCount:1')).not.toBeInTheDocument()
  })

  it('activates table-mode folder rows from the keyboard', () => {
    const onActivateFolder = jest.fn()

    render(
      <FolderTree
        folders={[createFolder()]}
        documents={[]}
        compact={false}
        onActivateFolder={onActivateFolder}
      />
    )

    const row = screen.getByRole('button', { name: /Reports/ })
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })

    expect(onActivateFolder).toHaveBeenCalledTimes(2)
    expect(onActivateFolder).toHaveBeenCalledWith(1)
  })

  it('does not activate table-mode folder rows from nested control key events', () => {
    const onActivateFolder = jest.fn()

    render(
      <FolderTree
        folders={[createFolder()]}
        documents={[]}
        compact={false}
        canSelectFolders={true}
        selectedFolderIds={new Set()}
        onSelectFolder={jest.fn()}
        onActivateFolder={onActivateFolder}
      />
    )

    fireEvent.keyDown(screen.getByTestId('folder-checkbox-1'), { key: ' ' })

    expect(onActivateFolder).not.toHaveBeenCalled()
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
