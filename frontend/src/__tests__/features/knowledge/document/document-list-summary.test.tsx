// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { DocumentList } from '@/features/knowledge/document/components/DocumentList'
import type { KnowledgeBase, KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'

let mockDocuments: KnowledgeDocument[] = []
let mockFolders: KnowledgeFolder[] = []
const mockFolderTree = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    replace: jest.fn(),
  }),
  usePathname: () => '/',
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: {
      id: 1,
    },
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useDocuments', () => ({
  useDocuments: () => ({
    documents: mockDocuments,
    loading: false,
    error: null,
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    batchDelete: jest.fn(),
    transfer: jest.fn(),
    refresh: jest.fn(),
    fetchWithFolder: jest.fn(),
    page: 1,
    pageSize: 20,
    totalCount: mockDocuments.length,
    totalPages: 1,
    hasMore: false,
    setPage: jest.fn(),
    setPageSize: jest.fn(),
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useFolders', () => ({
  useFolders: () => ({
    folders: mockFolders,
    loading: false,
    createFolder: jest.fn(),
    updateFolder: jest.fn(),
    deleteFolder: jest.fn(),
    fetchFolders: jest.fn(),
    moveDocument: jest.fn(),
    batchMove: jest.fn(),
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useColumnResize', () => ({
  useColumnResize: () => ({
    widthOverride: undefined,
    isResizing: false,
    handleMouseDown: jest.fn(),
    columnRef: { current: null },
  }),
}))

jest.mock('@/features/knowledge/document/components/DocumentDetailDialog', () => ({
  DocumentDetailDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/DocumentUpload', () => ({
  DocumentUpload: () => null,
}))
jest.mock('@/features/knowledge/document/components/DeleteDocumentDialog', () => ({
  DeleteDocumentDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/EditDocumentDialog', () => ({
  EditDocumentDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/RetrievalTestDialog', () => ({
  RetrievalTestDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/FolderTree', () => ({
  FolderTree: (props: {
    documents: KnowledgeDocument[]
    selectedIds: Set<number>
    isSelectionDisabled?: (document: KnowledgeDocument) => boolean
    onSelect?: (document: KnowledgeDocument, selected: boolean) => void
  }) => {
    mockFolderTree(props)
    return (
      <div>
        {props.documents.map(document => (
          <button
            key={document.id}
            data-testid={`compact-select-document-${document.id}`}
            disabled={props.isSelectionDisabled?.(document)}
            onClick={() => props.onSelect?.(document, !props.selectedIds.has(document.id))}
          />
        ))}
      </div>
    )
  },
}))
jest.mock('@/features/knowledge/document/components/knowledge-document-tree-grid', () => ({
  KnowledgeDocumentTreeGrid: ({
    documents,
    showSelectionColumn,
    canSelect,
    onSelect,
  }: {
    documents: KnowledgeDocument[]
    showSelectionColumn: boolean
    canSelect?: (document: KnowledgeDocument) => boolean
    onSelect?: (document: KnowledgeDocument, selected: boolean) => void
  }) => (
    <div>
      {documents.map(document => (
        <button
          key={document.id}
          type="button"
          data-testid={`select-document-${document.id}`}
          disabled={!showSelectionColumn || !canSelect?.(document)}
          onClick={() => onSelect?.(document, true)}
        >
          {document.name}
        </button>
      ))}
    </div>
  ),
}))
jest.mock('@/features/knowledge/document/components/CreateFolderDialog', () => ({
  CreateFolderDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/DeleteFolderDialog', () => ({
  DeleteFolderDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/MoveDocumentDialog', () => ({
  MoveDocumentDialog: () => null,
}))
jest.mock('@/features/knowledge/document/components/EditKnowledgeBaseSummaryDialog', () => ({
  EditKnowledgeBaseSummaryDialog: () => null,
}))

function createKnowledgeBase(overrides?: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    id: 1,
    name: 'Test KB',
    description: null,
    user_id: 1,
    namespace: 'default',
    document_count: 0,
    is_active: true,
    summary_enabled: true,
    summary: {
      status: 'failed',
      long_summary: 'AI summary',
      manual_long_summary: 'Manual summary',
      error: 'AI failed',
    },
    kb_type: 'classic',
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 5,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }
}

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

describe('DocumentList summary header', () => {
  beforeEach(() => {
    mockDocuments = []
    mockFolders = []
    mockFolderTree.mockClear()
  })

  it('shows inline summary edit button when manual summary exists after AI failure', () => {
    render(<DocumentList knowledgeBase={createKnowledgeBase()} canManageAllDocuments={true} />)

    expect(screen.getByTestId('kb-summary-inline-edit-button')).toBeInTheDocument()
  })

  it('shows inline summary edit button when no summary exists yet', () => {
    render(
      <DocumentList
        knowledgeBase={createKnowledgeBase({
          summary: {
            status: 'pending',
          },
        })}
        canManageAllDocuments={true}
      />
    )

    expect(screen.getByTestId('kb-summary-inline-edit-button')).toBeInTheDocument()
  })

  it('hides retry button when summary generation is disabled', () => {
    render(
      <DocumentList
        knowledgeBase={createKnowledgeBase({
          summary_enabled: false,
        })}
        canManageAllDocuments={true}
      />
    )

    expect(screen.queryByText('chatPage.summaryRetry')).not.toBeInTheDocument()
  })

  it('shows create-folder action for folder managers without upload permission', () => {
    render(
      <DocumentList
        knowledgeBase={createKnowledgeBase()}
        canUpload={false}
        canManageAllDocuments={true}
      />
    )

    expect(screen.getByText('document.folder.create')).toBeInTheDocument()
    expect(screen.queryByText('document.document.upload')).not.toBeInTheDocument()
  })

  it('shows batch actions for document-area editors without knowledge-base manage permission', () => {
    mockDocuments = [createDocument()]

    render(
      <DocumentList
        knowledgeBase={createKnowledgeBase({ document_count: 1 })}
        canUpload={true}
        canManageAllDocuments={false}
      />
    )

    fireEvent.click(screen.getByTestId('select-document-10'))

    expect(screen.getByTestId('batch-move-button')).toBeInTheDocument()
    expect(screen.getByTestId('batch-transfer-button')).toBeInTheDocument()
  })

  it('hides expand-all when the knowledge base has no folders', () => {
    mockDocuments = [createDocument()]

    render(<DocumentList knowledgeBase={createKnowledgeBase({ document_count: 1 })} />)

    expect(screen.queryByTestId('expand-all-toggle')).not.toBeInTheDocument()
  })

  it('shows expand-all when the knowledge base has folders and fewer than 200 documents', () => {
    mockFolders = [createFolder()]

    render(<DocumentList knowledgeBase={createKnowledgeBase({ document_count: 1 })} />)

    expect(screen.getByTestId('expand-all-toggle')).toBeInTheDocument()
  })

  it('orders workspace source controls and keeps folder management out of the workspace', () => {
    mockFolders = [createFolder()]
    mockDocuments = [createDocument()]
    const onSelectionChange = jest.fn()

    render(
      <DocumentList
        knowledgeBase={createKnowledgeBase({ document_count: 1 })}
        canUpload
        canManageAllDocuments
        compact
        sourceWorkspace
        selectedDocumentIds={[]}
        availableDocumentCount={48}
        onSelectionChange={onSelectionChange}
      />
    )

    const addSource = screen.getByTestId('document-add-source-full-width')
    const breadcrumb = screen.getByTestId('breadcrumb-root')
    const breadcrumbRow = screen.getByTestId('document-source-breadcrumb-row')
    const expandAll = screen.getByTestId('expand-all-toggle')
    const search = screen.getByTestId('document-source-search-input')
    const scopeSummary = screen.getByTestId('document-source-scope-summary')
    const selectCurrentPage = screen.getByTestId('document-select-current-page')
    const defaultScopeHint = screen.getByText('artifact.sourceDialog.defaultAllHint')

    expect(addSource).toHaveClass('w-full')
    expect(search).toHaveClass('w-full')
    expect(screen.getByText('artifact.addMaterials')).toBeInTheDocument()
    expect(scopeSummary).toContainElement(selectCurrentPage)
    expect(selectCurrentPage.compareDocumentPosition(defaultScopeHint)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(addSource.compareDocumentPosition(breadcrumb)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(breadcrumb.compareDocumentPosition(search)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(search.compareDocumentPosition(scopeSummary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(breadcrumbRow).toContainElement(expandAll)
    expect(defaultScopeHint).toBeInTheDocument()
    expect(screen.queryByTestId('document-use-all-sources')).not.toBeInTheDocument()
    expect(screen.queryByTestId('summary-info-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('kb-summary-inline-edit-button')).not.toBeInTheDocument()

    fireEvent.click(expandAll)
    expect(screen.getByTestId('document-source-breadcrumb-row')).toContainElement(
      screen.getByTestId('expand-all-toggle')
    )

    expect(mockFolderTree).toHaveBeenLastCalledWith(
      expect.objectContaining({
        canManageFolders: false,
        onCreateFolder: undefined,
        onRenameFolder: undefined,
        onDeleteFolder: undefined,
      })
    )
  })

  it('keeps controlled source selection and disables unavailable documents', () => {
    const available = createDocument({ id: 10 })
    const unavailable = createDocument({
      id: 11,
      name: 'unavailable.txt',
      is_active: false,
      index_status: 'failed',
    })
    mockDocuments = [available, unavailable]
    const onSelectionChange = jest.fn()

    render(
      <DocumentList
        knowledgeBase={createKnowledgeBase({ document_count: 2 })}
        compact
        sourceWorkspace
        selectedDocumentIds={[10]}
        availableDocumentCount={1}
        onSelectionChange={onSelectionChange}
      />
    )

    expect(mockFolderTree).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedIds: new Set([10]),
      })
    )
    expect(screen.getByTestId('compact-select-document-11')).toBeDisabled()
    expect(screen.getByText('artifact.sourceDialog.selectedHint')).toBeInTheDocument()
    expect(screen.queryByTestId('document-use-all-sources')).not.toBeInTheDocument()

    onSelectionChange.mockClear()
    fireEvent.click(screen.getByTestId('compact-select-document-10'))
    expect(onSelectionChange).toHaveBeenCalledWith([])
  })
})
