// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { DocumentUpload } from '@/features/knowledge/document/components/DocumentUpload'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

const mockUseBatchAttachment = jest.fn()

const mockGetSyncStatus = jest.fn()
const mockGetDocs = jest.fn()
const mockSyncDocs = jest.fn()
const mockGetWikispaceSyncStatus = jest.fn()
const mockGetWikispaceNodes = jest.fn()
const mockSyncWikispaceNodes = jest.fn()

jest.mock('@/apis/dingtalk-doc', () => ({
  dingtalkDocApi: {
    getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
    getDocs: (...args: unknown[]) => mockGetDocs(...args),
    syncDocs: (...args: unknown[]) => mockSyncDocs(...args),
    getWikispaceSyncStatus: (...args: unknown[]) => mockGetWikispaceSyncStatus(...args),
    getWikispaceNodes: (...args: unknown[]) => mockGetWikispaceNodes(...args),
    syncWikispaceNodes: (...args: unknown[]) => mockSyncWikispaceNodes(...args),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'document.document.upload': 'Upload documents',
        'document.document.dropzone': 'Drop files here',
        'document.upload.uploadFile': 'Upload file',
        'document.upload.pasteText': 'Paste text',
        'document.upload.dingtalk.entry': 'DingTalk document',
        'document.upload.dingtalk.title': 'Import DingTalk documents',
        'document.upload.dingtalk.hint': 'Pick DingTalk documents to import.',
        'document.upload.dingtalk.loading': 'Loading DingTalk documents...',
        'document.upload.dingtalk.notConfigured': 'DingTalk Docs is not configured',
        'document.upload.dingtalk.wikispaceNotConfigured':
          'DingTalk wiki spaces are not configured',
        'document.upload.dingtalk.empty': 'No documents',
        'document.upload.dingtalk.loadFailed': 'Failed to load',
        'document.upload.dingtalk.refresh': 'Refresh',
        'document.upload.dingtalk.refreshing': 'Refreshing...',
        'document.upload.dingtalk.refreshFailed': 'Failed to refresh',
        'document.upload.dingtalk.searchPlaceholder': 'Search documents',
        'document.upload.dingtalk.myDocs': 'My documents',
        'document.upload.dingtalk.wikispace': 'DingTalk wiki',
        'document.upload.dingtalk.lastSynced': 'Last refreshed',
        'document.upload.dingtalk.unsupported': 'Cannot be imported',
        'document.upload.dingtalk.selectedCount': 'Selected: {{count}}',
        'document.upload.dingtalk.limitError': 'At most 50 documents can be imported at once',
        'document.upload.dingtalk.sharedHint':
          'Imported content will be visible to knowledge base members',
        'document.upload.dingtalk.noPermission': 'You do not have permission to add documents',
        'document.upload.dingtalk.resultCreated': 'Created {{count}}',
        'document.upload.dingtalk.resultUpdated': 'updated {{count}}',
        'document.upload.dingtalk.resultProcessing': 'Already processing {{count}} (skipped)',
        'document.upload.dingtalk.resultSeparator': ', ',
        'document.upload.dingtalk.done': 'Done',
        'document.upload.dingtalk.addFailed': 'Failed to import',
        'document.upload.dingtalk.submitButton': 'Import',
        'document.upload.adding': 'Adding...',
        'document.folder.selectFolder': 'Select folder',
        'document.folder.rootLevel': 'Root level',
        'common:actions.cancel': 'Cancel',
      }

      const template = translations[key] ?? key
      if (!params) return template
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params[name] ?? ''))
    },
  }),
}))

jest.mock('@/hooks/useBatchAttachment', () => ({
  MAX_BATCH_FILES: 20,
  useBatchAttachment: () => mockUseBatchAttachment(),
}))

jest.mock('@/features/knowledge/document/components/SplitterSettingsSection', () => ({
  SplitterSettingsSection: () => <div data-testid="splitter-settings-section" />,
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function makeNode(overrides: Partial<DingtalkDocNode>): DingtalkDocNode {
  return {
    id: 1,
    dingtalk_node_id: 'node-1',
    name: 'Doc',
    doc_url: 'https://alidocs.dingtalk.com/i/nodes/node-1',
    parent_node_id: '',
    node_type: 'doc',
    workspace_id: '',
    content_type: 'ALIDOC',
    content_updated_at: '2026-08-26T00:00:00Z',
    source: 'docs',
    is_active: true,
    last_synced_at: '2026-08-26T00:00:00Z',
    created_at: '2026-08-26T00:00:00Z',
    updated_at: '2026-08-26T00:00:00Z',
    ...overrides,
  }
}

function docNode(id: string, name: string, extra: Partial<DingtalkDocNode> = {}) {
  return makeNode({ dingtalk_node_id: id, name, node_type: 'doc', ...extra })
}

function folderNode(id: string, name: string, children: DingtalkDocNode[] = []): DingtalkDocNode {
  return makeNode({
    dingtalk_node_id: id,
    name,
    node_type: 'folder',
    children,
  })
}

const DOCS_TREE = [
  folderNode('folder-1', 'Project', [
    docNode('doc-1', 'Spec Doc'),
    docNode('doc-2', 'API Doc'),
    makeNode({
      dingtalk_node_id: 'file-1',
      name: 'Binary File',
      node_type: 'file',
    }),
  ]),
  docNode('doc-3', 'Standalone Doc'),
]

const WIKISPACE_TREE = [docNode('wiki-1', 'Wiki Doc', { source: 'wikispace' })]

function setupDocsApi() {
  mockGetSyncStatus.mockResolvedValue({
    is_configured: true,
    total_nodes: 5,
    last_synced_at: '2026-08-26T02:00:00Z',
  })
  mockGetDocs.mockResolvedValue({ nodes: DOCS_TREE, total_count: 5 })
}

function setupWikispaceApi() {
  mockGetWikispaceSyncStatus.mockResolvedValue({
    is_configured: true,
    total_nodes: 1,
    last_synced_at: '2026-08-26T03:00:00Z',
  })
  mockGetWikispaceNodes.mockResolvedValue({ nodes: WIKISPACE_TREE, total_count: 1 })
}

function setupBatchAttachment() {
  mockUseBatchAttachment.mockReturnValue({
    state: { files: [], isUploading: false, summary: null },
    addFiles: jest.fn(),
    removeFile: jest.fn(),
    clearFiles: jest.fn(),
    startUpload: jest.fn(),
    retryFile: jest.fn(),
    renameFile: jest.fn(),
    reset: jest.fn(),
    applyDocumentCreationResults: jest.fn(),
  })
}

async function openDingtalkMode(
  props: Partial<Parameters<typeof DocumentUpload>[0]> = {},
  options: { waitForDocumentList?: boolean } = {}
) {
  render(
    <DocumentUpload
      open={true}
      onOpenChange={jest.fn()}
      onUploadComplete={jest.fn()}
      onDingtalkImport={jest.fn().mockResolvedValue({
        createdCount: 0,
        updatedCount: 0,
        processingCount: 0,
      })}
      {...props}
    />
  )
  fireEvent.click(screen.getByTestId('dingtalk-source-button'))
  if (options.waitForDocumentList !== false) {
    await screen.findByTestId('dingtalk-document-list')
  }
}

describe('DocumentUpload dingtalk source', () => {
  beforeEach(() => {
    mockUseBatchAttachment.mockReset()
    mockGetSyncStatus.mockReset()
    mockGetDocs.mockReset()
    mockSyncDocs.mockReset()
    mockGetWikispaceSyncStatus.mockReset()
    mockGetWikispaceNodes.mockReset()
    mockSyncWikispaceNodes.mockReset()
    setupBatchAttachment()
    setupDocsApi()
    setupWikispaceApi()
  })

  it('shows the dingtalk entry only when the handler is provided', () => {
    render(<DocumentUpload open={true} onOpenChange={jest.fn()} onUploadComplete={jest.fn()} />)

    expect(screen.queryByTestId('dingtalk-source-button')).not.toBeInTheDocument()

    render(
      <DocumentUpload
        open={true}
        onOpenChange={jest.fn()}
        onUploadComplete={jest.fn()}
        onDingtalkImport={jest.fn()}
      />
    )

    expect(screen.getByTestId('dingtalk-source-button')).toHaveClass('min-h-11')
  })

  it('preserves text and DingTalk selections when switching between source tabs', async () => {
    await openDingtalkMode()
    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-3'))

    fireEvent.mouseDown(screen.getByTestId('document-source-text'), { button: 0, ctrlKey: false })
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'Keep this draft' },
    })
    fireEvent.mouseDown(screen.getByTestId('dingtalk-source-button'), {
      button: 0,
      ctrlKey: false,
    })
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 1')

    fireEvent.mouseDown(screen.getByTestId('document-source-text'), { button: 0, ctrlKey: false })
    expect(screen.getByTestId('document-text-content')).toHaveValue('Keep this draft')
    expect(mockGetDocs).toHaveBeenCalledTimes(1)
  })

  it('shows the cached directory without syncing and displays last refresh time', async () => {
    await openDingtalkMode()

    expect(mockGetDocs).toHaveBeenCalled()
    expect(mockSyncDocs).not.toHaveBeenCalled()
    // Top level shows the folder and the standalone doc.
    expect(screen.getByTestId('dingtalk-folder-option-folder-1')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-document-option-doc-3')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-import-last-synced')).toHaveTextContent('Last refreshed')
  })

  it('does not retry a failed initial load until refresh is clicked', async () => {
    mockGetDocs.mockRejectedValueOnce(new Error('directory unavailable'))
    mockSyncDocs.mockResolvedValue({ added: 0, updated: 0, deleted: 0, total: 5 })

    await openDingtalkMode({}, { waitForDocumentList: false })

    expect(await screen.findByTestId('dingtalk-import-error')).toHaveTextContent('Failed to load')
    await waitFor(() => expect(mockGetDocs).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('dingtalk-import-refresh'))

    await waitFor(() => expect(mockGetDocs).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('dingtalk-document-option-doc-3')).toBeInTheDocument()
  })

  it('switches to the wikispace directory on tab click', async () => {
    await openDingtalkMode()

    expect(mockGetWikispaceNodes).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dingtalk-import-tab-wikispace'))

    await waitFor(() => expect(mockGetWikispaceNodes).toHaveBeenCalled())
    expect(await screen.findByTestId('dingtalk-document-option-wiki-1')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-option-doc-3')).not.toBeInTheDocument()
  })

  it('refreshes only on click and reloads the refreshed directory', async () => {
    mockSyncDocs.mockResolvedValue({ added: 1, updated: 0, deleted: 0, total: 6 })
    mockGetDocs.mockResolvedValueOnce({ nodes: DOCS_TREE, total_count: 5 }).mockResolvedValueOnce({
      nodes: [...DOCS_TREE, docNode('doc-4', 'Fresh Doc')],
      total_count: 6,
    })
    mockGetSyncStatus
      .mockResolvedValueOnce({
        is_configured: true,
        total_nodes: 5,
        last_synced_at: '2026-08-26T02:00:00Z',
      })
      .mockResolvedValue({
        is_configured: true,
        total_nodes: 6,
        last_synced_at: '2026-08-26T04:00:00Z',
      })

    await openDingtalkMode()

    fireEvent.click(screen.getByTestId('dingtalk-import-refresh'))

    await waitFor(() => expect(mockSyncDocs).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('dingtalk-document-option-doc-4')).toBeInTheDocument()
  })

  it('returns to the refreshed root after refreshing inside a folder', async () => {
    mockSyncDocs.mockResolvedValue({ added: 1, updated: 0, deleted: 0, total: 1 })
    await openDingtalkMode()

    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    expect(await screen.findByTestId('dingtalk-document-option-doc-1')).toBeInTheDocument()

    mockGetDocs.mockResolvedValue({
      nodes: [docNode('doc-4', 'Fresh Root Doc')],
      total_count: 1,
    })
    fireEvent.click(screen.getByTestId('dingtalk-import-refresh'))

    expect(await screen.findByTestId('dingtalk-document-option-doc-4')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-option-doc-1')).not.toBeInTheDocument()
  })

  it('keeps the old directory and selection when refresh fails', async () => {
    mockSyncDocs.mockRejectedValue(new Error('network down'))
    await openDingtalkMode()

    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    fireEvent.click(screen.getByTestId('dingtalk-import-refresh'))

    await waitFor(() => expect(mockSyncDocs).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('dingtalk-import-error')).toHaveTextContent(
      'Failed to refresh'
    )
    // The cached directory and the current selection survive the failure.
    expect(screen.getByTestId('dingtalk-folder-option-folder-1')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 2')
  })

  it('keeps the current folder when refreshing succeeds but reloading fails', async () => {
    mockSyncDocs.mockResolvedValue({ added: 0, updated: 1, deleted: 0, total: 5 })
    await openDingtalkMode()

    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    expect(await screen.findByTestId('dingtalk-document-option-doc-1')).toBeInTheDocument()

    mockGetDocs.mockRejectedValueOnce(new Error('directory unavailable'))
    fireEvent.click(screen.getByTestId('dingtalk-import-refresh'))

    expect(await screen.findByTestId('dingtalk-import-error')).toHaveTextContent(
      'Failed to refresh'
    )
    expect(screen.getByTestId('dingtalk-document-option-doc-1')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-option-doc-3')).not.toBeInTheDocument()
  })

  it('searches documents by name across the whole tree', async () => {
    await openDingtalkMode()

    fireEvent.change(screen.getByTestId('dingtalk-import-search'), {
      target: { value: 'spec' },
    })

    expect(screen.getByTestId('dingtalk-document-option-doc-1')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-option-doc-2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-option-doc-3')).not.toBeInTheDocument()
  })

  it('shows unsupported resources as visible but not selectable', async () => {
    await openDingtalkMode()

    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))

    expect(await screen.findByTestId('dingtalk-document-option-doc-1')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-node-unsupported-file-1')).toHaveTextContent(
      'Cannot be imported'
    )
    expect(screen.queryByTestId('dingtalk-node-select-file-1')).not.toBeInTheDocument()
  })

  it('shows folders as selectable without an unsupported warning', async () => {
    await openDingtalkMode()

    expect(screen.getByTestId('dingtalk-node-select-folder-1')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-node-unsupported-folder-1')).not.toBeInTheDocument()
  })

  it('navigates into folders with a breadcrumb', async () => {
    await openDingtalkMode()

    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))

    expect(await screen.findByTestId('dingtalk-document-option-doc-1')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-option-doc-3')).not.toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-import-breadcrumb-root')).toHaveClass('min-h-11')
    expect(screen.getByTestId('dingtalk-import-cancel')).toHaveClass('min-h-11')
    fireEvent.click(screen.getByTestId('dingtalk-import-breadcrumb-root'))
    expect(screen.getByTestId('dingtalk-document-option-doc-3')).toBeInTheDocument()
  })

  it('deduplicates folder and document selections when counting', async () => {
    await openDingtalkMode()

    // Select the whole folder (docs 1 and 2) plus one doc inside it.
    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 2')

    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    fireEvent.click(await screen.findByTestId('dingtalk-node-select-doc-1'))
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 2')
  })

  it('expands folder selections into document ids on submit', async () => {
    const onDingtalkImport = jest.fn().mockResolvedValue({
      createdCount: 2,
      updatedCount: 0,
      processingCount: 0,
    })
    await openDingtalkMode({ onDingtalkImport })

    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-3'))
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))

    await waitFor(() => expect(onDingtalkImport).toHaveBeenCalledTimes(1))
    expect(onDingtalkImport).toHaveBeenCalledWith(['doc-1', 'doc-2', 'doc-3'])
  })

  it('blocks submission above fifty documents', async () => {
    const manyDocs = Array.from({ length: 51 }, (_, index) =>
      docNode(`bulk-${index}`, `Bulk Doc ${index}`)
    )
    mockGetDocs.mockResolvedValue({ nodes: manyDocs, total_count: 51 })
    await openDingtalkMode()

    fireEvent.click(screen.getByTestId('dingtalk-node-select-bulk-0'))
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 1')

    const submit = screen.getByTestId('dingtalk-import-submit')
    expect(submit).not.toBeDisabled()

    for (let index = 1; index < 51; index += 1) {
      fireEvent.click(screen.getByTestId(`dingtalk-node-select-bulk-${index}`))
    }
    expect(screen.getByTestId('dingtalk-import-limit-error')).toBeInTheDocument()
    expect(submit).toBeDisabled()
  })

  it('defaults the target folder to the current folder selection', async () => {
    await openDingtalkMode({
      folderId: 7,
      folderOptions: [{ id: 7, name: 'Target', depth: 0 }],
    })

    const trigger = screen.getByTestId('dingtalk-import-folder-select')
    expect(trigger).toBeInTheDocument()
    // Radix Select renders the chosen item's text inside the trigger.
    expect(trigger).toHaveTextContent('Target')
  })

  it('warns that imported content is visible to members of a shared knowledge base', async () => {
    await openDingtalkMode({ isSharedKnowledgeBase: true })

    expect(screen.getByTestId('dingtalk-import-shared-hint')).toHaveTextContent(
      'Imported content will be visible to knowledge base members'
    )
  })

  it('disables submission without document management permission', async () => {
    await openDingtalkMode({ canManageDocuments: false })

    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-3'))
    expect(screen.getByTestId('dingtalk-import-no-permission')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-import-submit')).toBeDisabled()
  })

  it('keeps selections from both directory sources in one submit', async () => {
    const onDingtalkImport = jest.fn().mockResolvedValue({
      createdCount: 2,
      updatedCount: 0,
      processingCount: 0,
    })
    await openDingtalkMode({ onDingtalkImport })

    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-3'))
    fireEvent.click(screen.getByTestId('dingtalk-import-tab-wikispace'))
    fireEvent.click(await screen.findByTestId('dingtalk-node-select-wiki-1'))

    // The count spans both tabs; the docs selection is not dropped.
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 2')
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))

    await waitFor(() => expect(onDingtalkImport).toHaveBeenCalledWith(['doc-3', 'wiki-1']))
  })

  it('shows the submit result with accurate counts', async () => {
    const onOpenChange = jest.fn()
    const onDingtalkImport = jest.fn().mockResolvedValue({
      createdCount: 2,
      updatedCount: 1,
      processingCount: 1,
    })
    render(
      <DocumentUpload
        open={true}
        onOpenChange={onOpenChange}
        onUploadComplete={jest.fn()}
        onDingtalkImport={onDingtalkImport}
      />
    )
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))
    expect(await screen.findByTestId('dingtalk-import-search')).toHaveClass('h-11')
    await screen.findByTestId('dingtalk-document-list')

    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))

    expect(await screen.findByTestId('dingtalk-import-result')).toHaveTextContent(
      'Created 2, updated 1, Already processing 1 (skipped)'
    )
    // The dialog stays open until the user acknowledges the result.
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dingtalk-import-done'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each([
    [1, 0, 0, 'Created 1'],
    [0, 1, 0, 'updated 1'],
    [0, 0, 1, 'Already processing 1 (skipped)'],
    [1, 0, 1, 'Created 1, Already processing 1 (skipped)'],
    [0, 0, 0, null],
  ])('omits zero result counts (%i, %i, %i)', async (created, updated, processing, expected) => {
    const onDingtalkImport = jest.fn().mockResolvedValue({
      createdCount: created,
      updatedCount: updated,
      processingCount: processing,
    })
    await openDingtalkMode({ onDingtalkImport })
    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-3'))
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))
    await screen.findByTestId('dingtalk-import-done')

    if (expected === null) {
      expect(screen.queryByTestId('dingtalk-import-result')).not.toBeInTheDocument()
    } else {
      expect(screen.getByTestId('dingtalk-import-result').textContent).toBe(expected)
    }
  })

  it('keeps the dialog open and shows the error when the import fails', async () => {
    mockGetDocs.mockResolvedValue({ nodes: [docNode('doc-9', 'Failing Doc')], total_count: 1 })
    const onDingtalkImport = jest.fn().mockRejectedValue('conflict')

    render(
      <DocumentUpload
        open={true}
        onOpenChange={jest.fn()}
        onUploadComplete={jest.fn()}
        onDingtalkImport={onDingtalkImport}
      />
    )
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))
    fireEvent.click(await screen.findByTestId('dingtalk-node-select-doc-9'))
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))

    await waitFor(() => expect(onDingtalkImport).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('dingtalk-import-error')).toHaveTextContent('Failed to import')
    expect(screen.queryByTestId('dingtalk-import-result')).not.toBeInTheDocument()
  })

  it('shows the not-configured hint instead of the list', async () => {
    mockGetSyncStatus.mockResolvedValue({ is_configured: false, total_nodes: 0 })

    render(
      <DocumentUpload
        open={true}
        onOpenChange={jest.fn()}
        onUploadComplete={jest.fn()}
        onDingtalkImport={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))

    await waitFor(() => expect(mockGetSyncStatus).toHaveBeenCalled())
    expect(await screen.findByText('DingTalk Docs is not configured')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-list')).not.toBeInTheDocument()
    expect(mockGetDocs).not.toHaveBeenCalled()
  })
})
