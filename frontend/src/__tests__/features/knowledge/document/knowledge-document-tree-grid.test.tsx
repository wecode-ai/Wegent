// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { KnowledgeDocumentTreeGrid } from '@/features/knowledge/document/components/knowledge-document-tree-grid'
import { buildKnowledgeResourceTree } from '@/features/knowledge/document/utils/resource-tree'
import type { KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, number>) =>
      params?.count !== undefined ? `${key}:${params.count}` : key,
  }),
}))

jest.mock('@/apis/attachments', () => {
  const actual = jest.requireActual('@/apis/attachments')
  return {
    ...actual,
    downloadAttachment: jest.fn(),
  }
})

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

const requiredTreeGridProps = {
  sortField: 'createdAt' as const,
  sortOrder: 'desc' as const,
  onSortChange: jest.fn(),
  isAllSelected: false,
  isPartialSelected: false,
  onSelectAll: jest.fn(),
  selectAllLabel: 'select all',
}

describe('KnowledgeDocumentTreeGrid', () => {
  it('identifies imported documents as external rather than just their file extension', () => {
    const documents = [createDocument({ source_type: 'external', file_extension: '.PDF' })]
    const { nodes, index } = buildKnowledgeResourceTree([], documents)
    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={[]}
        documents={documents}
        {...requiredTreeGridProps}
        showSelectionColumn={false}
        showActionsColumn={false}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )
    expect(screen.getByText('document.document.type.external')).toBeInTheDocument()
    expect(screen.queryByText('.PDF')).not.toBeInTheDocument()
    expect(screen.getByText('doc.txt').parentElement?.querySelector('svg')).toHaveClass(
      'lucide-file-text',
      'text-error'
    )
  })

  it('keeps the markdown type and adds a Wiki icon for synchronized documents', () => {
    const documents = [
      createDocument({
        source_type: 'external',
        file_extension: 'md',
        source_config: {
          external: {
            provider: 'wiki',
            title: 'Operations handbook',
            sync: { enabled: true },
          },
        },
      }),
    ]
    const { nodes, index } = buildKnowledgeResourceTree([], documents)
    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={[]}
        documents={documents}
        {...requiredTreeGridProps}
        showSelectionColumn={false}
        showActionsColumn={false}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )

    const type = screen.getByTestId('synced-wiki-document-type')
    expect(type).toHaveTextContent('MD')
    expect(type.querySelector('svg')).toHaveClass('lucide-book-open')
    expect(type).toHaveAttribute('title', 'wikiSection.synced_badge')
  })

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
        {...requiredTreeGridProps}
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
        {...requiredTreeGridProps}
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
        {...requiredTreeGridProps}
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

  it('delegates sortable header changes to the controlled sort contract', () => {
    const onSortChange = jest.fn()
    const folders: KnowledgeFolder[] = []
    const documents = [createDocument({ id: 11, name: 'root.txt', folder_id: 0 })]
    const { nodes, index } = buildKnowledgeResourceTree(folders, documents)

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={documents}
        {...requiredTreeGridProps}
        sortField="createdAt"
        sortOrder="desc"
        onSortChange={onSortChange}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /document.document.columns.size/ }))

    expect(onSortChange).toHaveBeenCalledWith('size', 'desc')
  })

  it('keeps horizontal scrolling owned by the outer table viewport', () => {
    const folders: KnowledgeFolder[] = []
    const documents = [createDocument({ id: 11, name: 'root.txt', folder_id: 0 })]
    const { nodes, index } = buildKnowledgeResourceTree(folders, documents)

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={documents}
        {...requiredTreeGridProps}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )

    expect(screen.getByTestId('knowledge-document-treegrid-virtual-scroll')).toHaveClass(
      'overflow-y-auto',
      'overflow-x-hidden'
    )
  })

  it('renders icon actions only when handlers exist and exposes stable selectors', () => {
    const onEdit = jest.fn()
    const onDelete = jest.fn()
    const folders: KnowledgeFolder[] = []
    const documents = [createDocument({ id: 11, name: 'root.txt', folder_id: 0 })]
    const { nodes, index } = buildKnowledgeResourceTree(folders, documents)

    const { rerender } = render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={documents}
        {...requiredTreeGridProps}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )

    expect(screen.queryByTestId('edit-document-11')).not.toBeInTheDocument()

    rerender(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={documents}
        {...requiredTreeGridProps}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    )

    fireEvent.click(screen.getByTestId('edit-document-11'))
    fireEvent.click(screen.getByTestId('delete-document-11'))

    expect(screen.getByLabelText('common:actions.edit')).toBeInTheDocument()
    expect(screen.getByLabelText('common:actions.delete')).toBeInTheDocument()
    expect(onEdit).toHaveBeenCalledWith(documents[0])
    expect(onDelete).toHaveBeenCalledWith(documents[0])
  })

  it('opens only safe external source links', () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null)
    const folders: KnowledgeFolder[] = []
    const unsafeDocument = createDocument({
      id: 11,
      name: 'unsafe.md',
      source_type: 'web',
      source_config: { url: 'javascript:alert(1)' },
    })
    const safeDocument = createDocument({
      id: 12,
      name: 'safe.md',
      source_type: 'web',
      source_config: { url: 'https://example.com/page' },
    })

    const unsafeTree = buildKnowledgeResourceTree(folders, [unsafeDocument])
    const { rerender } = render(
      <KnowledgeDocumentTreeGrid
        nodes={unsafeTree.nodes}
        treeIndex={unsafeTree.index}
        folders={folders}
        documents={[unsafeDocument]}
        {...requiredTreeGridProps}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )

    fireEvent.click(screen.getByTestId('open-document-source-11'))
    expect(openSpy).not.toHaveBeenCalled()

    const safeTree = buildKnowledgeResourceTree(folders, [safeDocument])
    rerender(
      <KnowledgeDocumentTreeGrid
        nodes={safeTree.nodes}
        treeIndex={safeTree.index}
        folders={folders}
        documents={[safeDocument]}
        {...requiredTreeGridProps}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )

    fireEvent.click(screen.getByTestId('open-document-source-12'))
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com/page',
      '_blank',
      'noopener,noreferrer'
    )

    openSpy.mockRestore()
  })

  it('offers the dedicated retry entry for failed external imports', () => {
    const onReindex = jest.fn()
    const folders: KnowledgeFolder[] = []
    const failedExternal = createDocument({
      id: 21,
      name: 'external-doc.md',
      source_type: 'external',
      index_status: 'failed',
      is_active: false,
    })
    const failedRegular = createDocument({
      id: 22,
      name: 'regular-doc.txt',
      index_status: 'failed',
      is_active: false,
    })
    const { nodes, index } = buildKnowledgeResourceTree(folders, [failedExternal, failedRegular])

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={[failedExternal, failedRegular]}
        {...requiredTreeGridProps}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
        onReindex={onReindex}
        canManage={() => true}
        ragConfigured={false}
      />
    )

    // External retry does not depend on RAG configuration, and never reuses
    // the ordinary reindex control.
    fireEvent.click(screen.getByTestId('retry-import-document-21'))
    expect(onReindex).toHaveBeenCalledWith(failedExternal)
    expect(screen.queryByTestId('reindex-document-21')).not.toBeInTheDocument()
    expect(screen.getByLabelText('document.document.retryImport')).toBeInTheDocument()

    // Without RAG configuration the regular reindex control stays hidden.
    expect(screen.queryByTestId('reindex-document-22')).not.toBeInTheDocument()
  })

  it('keeps the delete action visible for synchronized wiki documents', () => {
    const onDelete = jest.fn()
    const syncedWiki = createDocument({
      id: 23,
      name: 'synchronized-wiki.md',
      source_type: 'external',
      file_extension: 'md',
      attachment_id: 230,
      source_config: {
        external: {
          provider: 'wiki',
          title: 'Synchronized Wiki',
          sync: { enabled: true },
        },
      },
    })
    const { nodes, index } = buildKnowledgeResourceTree([], [syncedWiki])

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={[]}
        documents={[syncedWiki]}
        {...requiredTreeGridProps}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
        onMove={jest.fn()}
        onSync={jest.fn()}
        onReindex={jest.fn()}
        onDelete={onDelete}
        canManage={() => true}
      />
    )

    const row = screen.getByTestId('document-row-23')
    expect(row.style.gridTemplateColumns.endsWith('168px')).toBe(true)
    fireEvent.click(screen.getByTestId('delete-document-23'))
    expect(onDelete).toHaveBeenCalledWith(syncedWiki)
  })

  it('shows a missing source warning without changing a synchronized wiki index status', () => {
    const syncedWiki = createDocument({
      id: 26,
      source_type: 'external',
      attachment_id: 260,
      index_status: 'success',
      source_config: {
        external: {
          provider: 'wiki',
          title: 'Synchronized Wiki',
          status: 'inaccessible',
          sync: {
            enabled: true,
            last_error_code: 'external_source_missing',
          },
        },
      },
    })
    const { nodes, index } = buildKnowledgeResourceTree([], [syncedWiki])

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={[]}
        documents={[syncedWiki]}
        {...requiredTreeGridProps}
        showSelectionColumn={false}
        showActionsColumn={false}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )

    expect(screen.getByTestId('wiki-source-missing-26')).toHaveTextContent(
      'document.document.wikiSourceMissing'
    )
    expect(screen.getByText('document.document.indexStatus.available')).toBeInTheDocument()
  })

  it('shows synchronized wiki reindex only for a failed index', () => {
    const syncedConfig = {
      external: {
        provider: 'wiki',
        title: 'Synchronized Wiki',
        sync: { enabled: true },
      },
    }
    const successful = createDocument({
      id: 24,
      source_type: 'external',
      attachment_id: 240,
      source_config: syncedConfig,
      index_status: 'success',
    })
    const failed = createDocument({
      id: 25,
      source_type: 'external',
      attachment_id: 250,
      source_config: syncedConfig,
      index_status: 'failed',
    })
    const documents = [successful, failed]
    const { nodes, index } = buildKnowledgeResourceTree([], documents)

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={[]}
        documents={documents}
        {...requiredTreeGridProps}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
        onSync={jest.fn()}
        onReindex={jest.fn()}
        canManage={() => true}
        ragConfigured
      />
    )

    expect(screen.getByTestId('sync-document-24')).toBeInTheDocument()
    expect(screen.queryByTestId('reindex-document-24')).not.toBeInTheDocument()
    expect(screen.getByTestId('sync-document-25')).toBeInTheDocument()
    expect(screen.getByTestId('reindex-document-25')).toBeInTheDocument()
  })

  it('disables quick synchronization while the document is processing', () => {
    const syncedWiki = createDocument({
      id: 27,
      source_type: 'external',
      attachment_id: 270,
      index_status: 'indexing',
      source_config: {
        external: {
          provider: 'wiki',
          title: 'Synchronized Wiki',
          sync: { enabled: true },
        },
      },
    })
    const onSync = jest.fn()
    const { nodes, index } = buildKnowledgeResourceTree([], [syncedWiki])

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={[]}
        documents={[syncedWiki]}
        {...requiredTreeGridProps}
        showSelectionColumn={false}
        showActionsColumn
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
        onSync={onSync}
        syncingDocId={27}
        canManage={() => true}
      />
    )

    const quickSync = screen.getByTestId('quick-sync-document-27')
    expect(quickSync).toBeDisabled()
    fireEvent.click(quickSync)
    expect(onSync).not.toHaveBeenCalled()
  })

  it('activates document rows from the keyboard', () => {
    const onViewDetail = jest.fn()
    const folders: KnowledgeFolder[] = []
    const documents = [createDocument({ id: 11, name: 'root.txt', folder_id: 0 })]
    const { nodes, index } = buildKnowledgeResourceTree(folders, documents)

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={documents}
        {...requiredTreeGridProps}
        showSelectionColumn={true}
        showActionsColumn={true}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
        onViewDetail={onViewDetail}
      />
    )

    fireEvent.keyDown(screen.getByRole('button', { name: /root.txt/ }), { key: 'Enter' })

    expect(onViewDetail).toHaveBeenCalledWith(documents[0])
  })

  it('shows wiki source page metadata: real size and source update time', () => {
    const formatLocal = (iso: string) =>
      new Date(iso).toLocaleString('sv-SE', { hour12: false }).replace(/-/g, '/')

    const folders: KnowledgeFolder[] = []
    const syncedWiki = createDocument({
      id: 31,
      name: 'synced-wiki.md',
      source_type: 'external',
      file_size: 15,
      created_at: '2026-09-04T00:00:00Z',
      updated_at: '2026-09-04T00:00:00Z',
      source_config: {
        external: {
          provider: 'wiki',
          title: 'Synced Wiki',
          sync: { enabled: true, content_version: '2026-09-03T12:34:56Z' },
        },
      },
    })
    const { nodes, index } = buildKnowledgeResourceTree(folders, [syncedWiki])

    render(
      <KnowledgeDocumentTreeGrid
        nodes={nodes}
        treeIndex={index}
        folders={folders}
        documents={[syncedWiki]}
        {...requiredTreeGridProps}
        showSelectionColumn={false}
        showActionsColumn={false}
        selectedFolderIds={new Set()}
        selectedDocumentIds={new Set()}
      />
    )

    // Real byte sizes, not the 0 B placeholder.
    expect(screen.getByText('15 B')).toBeInTheDocument()
    const expectedTime = formatLocal('2026-09-03T12:34:56Z')
    expect(screen.getByText(expectedTime)).toBeInTheDocument()
  })
})
