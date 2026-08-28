// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { DocumentUpload } from '@/features/knowledge/document/components/DocumentUpload'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

const mockUseBatchAttachment = jest.fn()
const mockGetExternalDocumentImportStatuses = jest.fn()

jest.mock('@/apis/knowledge', () => ({
  ...jest.requireActual('@/apis/knowledge'),
  getExternalDocumentImportStatuses: (...args: unknown[]) =>
    mockGetExternalDocumentImportStatuses(...args),
}))

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
      const dingtalk = jest.requireActual('@/i18n/locales/en/knowledge.json').document.upload
        .dingtalk
      const translations: Record<string, string> = {
        'document.document.upload': 'Upload documents',
        'document.document.dropzone': 'Drop files here',
        'document.upload.uploadFile': 'Upload file',
        'document.upload.pasteText': 'Paste text',
        'document.upload.dingtalk.entry': 'DingTalk document',
        'document.upload.dingtalk.title': 'Import DingTalk documents',
        'document.upload.dingtalk.hint': 'Pick DingTalk documents to import.',
        'document.upload.dingtalk.help': 'Import details',
        'document.upload.dingtalk.compactHint': dingtalk.compactHint,
        'document.upload.dingtalk.loading': 'Loading DingTalk documents...',
        'document.upload.dingtalk.notConfigured': 'DingTalk Docs is not configured',
        'document.upload.dingtalk.wikispaceNotConfigured': dingtalk.wikispaceNotConfigured,
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
        'document.upload.dingtalk.unsupportedFormat': dingtalk.unsupportedFormat,
        'document.upload.dingtalk.selectedCount': 'Selected: {{count}}',
        'document.upload.dingtalk.folderDocumentCount': dingtalk.folderDocumentCount,
        'document.upload.dingtalk.documentCount': dingtalk.documentCount,
        'document.upload.dingtalk.searchCount': dingtalk.searchCount,
        'document.upload.dingtalk.folderDocumentCountHint':
          'Importable documents, including all descendants',
        'document.upload.dingtalk.limitError': 'At most 50 documents can be imported at once',
        'document.upload.dingtalk.sharedHint': dingtalk.sharedHint,
        'document.upload.dingtalk.noPermission': 'You do not have permission to add documents',
        'document.upload.dingtalk.resultCreated': 'Created {{count}}',
        'document.upload.dingtalk.resultUpdated': 'updated {{count}}',
        'document.upload.dingtalk.resultProcessing': 'Already processing {{count}} (skipped)',
        'document.upload.dingtalk.resultSeparator': ', ',
        'document.upload.dingtalk.done': 'Done',
        'document.upload.dingtalk.addFailed': 'Failed to import',
        'document.upload.dingtalk.tableNotConfigured': dingtalk.tableNotConfigured,
        'document.upload.dingtalk.submitButton': 'Import',
        'document.upload.dingtalk.selectAll': 'Select all',
        'document.upload.dingtalk.clearSelection': 'Clear selection',
        'document.upload.dingtalk.selectSearchResults': 'Select results',
        'document.upload.dingtalk.clearSearchSelection': 'Clear result selection',
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
  return makeNode({ dingtalk_node_id: id, name, node_type: 'doc', extension: 'adoc', ...extra })
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
      knowledgeBaseId={42}
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
  it('distinguishes wiki roots from folders while expanding their contents', async () => {
    mockGetWikispaceNodes.mockResolvedValue({
      nodes: [
        makeNode({
          ...folderNode('space-1', 'Knowledge base', [
            makeNode({
              ...folderNode('nested', 'Folder', [
                docNode('wiki-doc', 'Wiki Doc', { source: 'wikispace' }),
              ]),
              source: 'wikispace',
              workspace_id: 'space-1',
            }),
          ]),
          source: 'wikispace',
          workspace_id: 'space-1',
        }),
      ],
      total_count: 3,
    })
    await openDingtalkMode()
    expect(screen.getByTestId('dingtalk-node-name-folder-1').querySelector('svg')).toHaveClass(
      'lucide-folder'
    )
    fireEvent.click(screen.getByTestId('dingtalk-import-tab-wikispace'))
    const root = await screen.findByTestId('dingtalk-node-name-space-1')
    expect(root.querySelector('svg')).toHaveClass('lucide-book-open', 'text-primary')
    fireEvent.click(root)
    expect(root.querySelector('svg')).toHaveClass('lucide-book-open')
    const nested = screen.getByTestId('dingtalk-node-name-nested')
    expect(nested.querySelector('svg')).toHaveClass('lucide-folder', 'text-text-secondary')
    fireEvent.click(nested)
    expect(nested.querySelector('svg')).toHaveClass('lucide-folder-open')
    expect(screen.getByTestId('dingtalk-node-name-wiki-doc')).toBeInTheDocument()
  })

  it('shows colored format icons independently of import eligibility', async () => {
    const formats = [
      ['adoc', 'lucide-file-text', 'text-blue-600', 'dark:text-blue-400'],
      ['able', 'lucide-table-2', 'text-primary'],
      ['axls', 'lucide-file-spreadsheet', 'text-green-600', 'dark:text-green-400'],
      ['pptx', 'lucide-presentation', 'text-orange-600', 'dark:text-orange-400'],
      ['pdf', 'lucide-file-text', 'text-error'],
      ['mp3', 'lucide-file-headphone', 'text-orange-600', 'dark:text-orange-400'],
      ['unknown', 'lucide-file', 'text-text-muted'],
    ]
    mockGetDocs.mockResolvedValue({
      nodes: formats.map(([extension]) =>
        makeNode({ dingtalk_node_id: extension, node_type: 'file', extension })
      ),
      total_count: formats.length,
    })
    await openDingtalkMode()
    for (const [extension, ...iconClasses] of formats) {
      expect(
        screen.getByTestId(`dingtalk-node-name-${extension}`).querySelector('svg')
      ).toHaveClass(...iconClasses)
    }
    expect(screen.getByTestId('dingtalk-node-configure-axls')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-node-select-axls')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-node-select-mp3')).not.toBeInTheDocument()
  })

  it('identifies dlink resources without offering or submitting them for import', async () => {
    const onDingtalkImport = jest.fn().mockResolvedValue({ createdCount: 1 })
    mockGetDocs.mockResolvedValue({
      nodes: [
        makeNode({
          dingtalk_node_id: 'link-1',
          name: 'Linked document',
          node_type: 'file',
          content_type: 'OTHER',
          extension: 'dlink',
        }),
        docNode('doc-1', 'Text document'),
      ],
      total_count: 2,
    })
    await openDingtalkMode({ onDingtalkImport })
    const link = screen.getByTestId('dingtalk-node-name-link-1')
    expect(link.querySelector('svg')).toHaveClass('lucide-link-2', 'text-blue-600')
    expect(link).toBeDisabled()
    expect(screen.getByTestId('dingtalk-node-unsupported-link-1')).toHaveTextContent(
      'Cannot be imported (dlink)'
    )
    expect(screen.queryByTestId('dingtalk-node-select-link-1')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('dingtalk-import-search'), {
      target: { value: 'Linked' },
    })
    expect(screen.getByText('0 matching importable documents')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-import-select-all')).toBeDisabled()
    fireEvent.change(screen.getByTestId('dingtalk-import-search'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('dingtalk-import-select-all'))
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))
    await waitFor(() => expect(onDingtalkImport).toHaveBeenCalledWith(['doc-1']))
  })

  it.each(['docs', 'wikispace'] as const)(
    'requires format metadata before selection and restores eligibility after refresh (%s)',
    async source => {
      const getNodes = source === 'docs' ? mockGetDocs : mockGetWikispaceNodes
      const syncNodes = source === 'docs' ? mockSyncDocs : mockSyncWikispaceNodes
      const staleNodes = [
        docNode('legacy', 'Legacy Doc', { source, extension: '' }),
        docNode('unsupported', 'Unsupported Doc', { source, extension: 'appt' }),
        docNode('missing-type', 'Missing Type', { source, content_type: '' }),
      ]
      getNodes.mockResolvedValueOnce({ nodes: staleNodes, total_count: 3 }).mockResolvedValue({
        nodes: [
          docNode('legacy', 'Legacy Doc', { source, node_type: 'file' }),
          ...staleNodes.slice(1),
        ],
        total_count: 3,
      })
      syncNodes.mockResolvedValue({ added: 0, updated: 1, deleted: 0, total: 3 })
      await openDingtalkMode()
      if (source === 'wikispace') {
        fireEvent.click(screen.getByTestId('dingtalk-import-tab-wikispace'))
      }
      await screen.findByTestId('dingtalk-document-option-legacy')
      for (const node of staleNodes) {
        expect(
          screen.queryByTestId(`dingtalk-node-select-${node.dingtalk_node_id}`)
        ).not.toBeInTheDocument()
      }
      fireEvent.click(screen.getByTestId('dingtalk-import-refresh'))
      expect(await screen.findByTestId('dingtalk-node-select-legacy')).toBeEnabled()
      expect(screen.queryByTestId('dingtalk-node-select-unsupported')).not.toBeInTheDocument()
    }
  )

  it.each([
    [false, false, ['doc', 'pdf']],
    [true, false, ['doc', 'pdf', 'base']],
    [false, true, ['doc', 'pdf', 'sheet']],
    [true, true, ['doc', 'pdf', 'base', 'sheet']],
  ])(
    'selects only configured spreadsheet formats (AI: %s, Table: %s)',
    async (aiConfigured, tableConfigured, expectedIds) => {
      mockGetSyncStatus.mockResolvedValue({
        is_configured: true,
        ai_table_configured: aiConfigured,
        table_configured: tableConfigured,
      })
      mockGetDocs.mockResolvedValue({
        nodes: [
          docNode('doc', 'Text'),
          makeNode({
            dingtalk_node_id: 'pdf',
            name: 'Report.pdf',
            node_type: 'file',
            content_type: 'DOCUMENT',
            extension: 'pdf',
          }),
          makeNode({
            dingtalk_node_id: 'base',
            name: 'AI Table',
            node_type: 'file',
            extension: 'able',
          }),
          makeNode({
            dingtalk_node_id: 'sheet',
            name: 'Online sheet',
            node_type: 'file',
            extension: 'axls',
          }),
        ],
        total_count: 4,
      })
      const onImport = jest
        .fn()
        .mockResolvedValue({ createdCount: 2, updatedCount: 0, processingCount: 0 })
      await openDingtalkMode({ onDingtalkImport: onImport })
      if (!aiConfigured) {
        expect(screen.getByTestId('dingtalk-node-configure-base')).toHaveAttribute(
          'href',
          '/settings?tab=integrations'
        )
      }
      if (!tableConfigured) {
        expect(screen.getByTestId('dingtalk-node-configure-sheet')).toHaveAttribute(
          'href',
          '/settings?tab=integrations'
        )
        expect(screen.queryByTestId('dingtalk-node-select-sheet')).not.toBeInTheDocument()
      }
      fireEvent.click(screen.getByTestId('dingtalk-import-select-all'))
      fireEvent.click(screen.getByTestId('dingtalk-import-submit'))
      await waitFor(() => expect(onImport).toHaveBeenCalled())
      expect(onImport.mock.calls[0][0]).toEqual(expectedIds)
    }
  )

  it.each(['docs', 'wikispace'] as const)(
    'keeps a mixed folder importable and restores its sheet after configuration refresh (%s)',
    async source => {
      const getStatus = source === 'docs' ? mockGetSyncStatus : mockGetWikispaceSyncStatus
      const getNodes = source === 'docs' ? mockGetDocs : mockGetWikispaceNodes
      getStatus.mockResolvedValue({ is_configured: true, table_configured: false })
      getNodes.mockResolvedValue({
        nodes: [
          folderNode('mixed', 'Mixed', [
            docNode('text', 'Text', { source }),
            docNode('sheet', 'Sheet', { source, node_type: 'file', extension: 'axls' }),
          ]),
        ],
        total_count: 3,
      })
      const onImport = jest
        .fn()
        .mockResolvedValue({ createdCount: 1, updatedCount: 0, processingCount: 0 })
      await openDingtalkMode({ onDingtalkImport: onImport })
      if (source === 'wikispace')
        fireEvent.click(screen.getByTestId('dingtalk-import-tab-wikispace'))
      fireEvent.click(await screen.findByTestId('dingtalk-folder-navigate-mixed'))
      fireEvent.click(screen.getByTestId('dingtalk-node-select-mixed'))
      expect(screen.getByTestId('dingtalk-folder-document-count-mixed')).toHaveTextContent('1')
      expect(screen.getByTestId('dingtalk-node-select-text')).toHaveAttribute(
        'aria-checked',
        'true'
      )
      expect(screen.queryByTestId('dingtalk-node-select-sheet')).not.toBeInTheDocument()

      getStatus.mockResolvedValue({ is_configured: true, table_configured: true })
      fireEvent.click(screen.getByTestId('dingtalk-import-refresh'))
      const sheet = await screen.findByTestId('dingtalk-node-select-sheet')
      expect(sheet).toBeEnabled()
      expect(sheet).toHaveAttribute('aria-checked', 'false')
      expect(screen.getByTestId('dingtalk-folder-document-count-mixed')).toHaveTextContent('2')
      fireEvent.click(screen.getByTestId('dingtalk-import-submit'))
      await waitFor(() => expect(onImport).toHaveBeenCalledWith(['text']))
    }
  )

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
    mockGetExternalDocumentImportStatuses.mockReset().mockResolvedValue({})
  })

  it('shows current-KB import outcomes on document leaves, including collapsed descendants', async () => {
    mockGetExternalDocumentImportStatuses.mockResolvedValue({
      'doc-1': 'success',
      'doc-2': 'failed',
      'doc-3': 'indexing',
    })
    await openDingtalkMode()
    await waitFor(() =>
      expect(mockGetExternalDocumentImportStatuses).toHaveBeenCalledWith(42, 'dingtalk', [
        'doc-1',
        'doc-2',
        'doc-3',
      ])
    )
    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    expect(await screen.findByText('document.upload.dingtalk.imported')).toBeInTheDocument()
    expect(screen.getByText('document.upload.dingtalk.importFailed')).toBeInTheDocument()
    expect(screen.getByText('document.upload.dingtalk.importProcessing')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('dingtalk-folder-option-folder-1')).queryByTestId(
        'dingtalk-import-status-folder-1'
      )
    ).not.toBeInTheDocument()
  })

  it('reports an unknown import status and lets the user retry without losing selection', async () => {
    mockGetExternalDocumentImportStatuses.mockRejectedValue(new Error('offline'))
    await openDingtalkMode()
    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-3'))
    expect(await screen.findByText('document.upload.dingtalk.statusLoadFailed')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-import-status-doc-3')).not.toBeInTheDocument()
    mockGetExternalDocumentImportStatuses.mockResolvedValue({ 'doc-3': 'success' })
    fireEvent.click(screen.getByTestId('dingtalk-import-status-retry'))
    expect(await screen.findByTestId('dingtalk-import-status-doc-3')).toHaveTextContent(
      'document.upload.dingtalk.imported'
    )
    expect(screen.queryByText('document.upload.dingtalk.statusLoadFailed')).not.toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-node-select-doc-3')).toHaveAttribute('aria-checked', 'true')
  })

  it('does not display a late response from a previous knowledge base', async () => {
    let resolveOld: (value: Record<string, string>) => void = () => {}
    mockGetExternalDocumentImportStatuses.mockImplementation(
      (kbId: number, _provider: string, ids: string[]) =>
        kbId === 42 && ids.length
          ? new Promise(resolve => {
              resolveOld = resolve
            })
          : Promise.resolve({})
    )
    const props = {
      open: true,
      onOpenChange: jest.fn(),
      onUploadComplete: jest.fn(),
      onDingtalkImport: jest.fn(),
    }
    const { rerender } = render(<DocumentUpload knowledgeBaseId={42} {...props} />)
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))
    await screen.findByTestId('dingtalk-document-list')
    await waitFor(() =>
      expect(mockGetExternalDocumentImportStatuses).toHaveBeenCalledWith(42, 'dingtalk', [
        'doc-1',
        'doc-2',
        'doc-3',
      ])
    )
    rerender(<DocumentUpload knowledgeBaseId={43} {...props} />)
    await waitFor(() =>
      expect(mockGetExternalDocumentImportStatuses).toHaveBeenCalledWith(43, 'dingtalk', [
        'doc-1',
        'doc-2',
        'doc-3',
      ])
    )
    await act(async () => resolveOld({ 'doc-3': 'success' }))
    expect(screen.queryByTestId('dingtalk-import-status-doc-3')).not.toBeInTheDocument()
  })

  it('refreshes import status with the directory and preserves the selected documents', async () => {
    mockGetExternalDocumentImportStatuses.mockResolvedValue({ 'doc-3': 'indexing' })
    await openDingtalkMode()
    expect(await screen.findByTestId('dingtalk-import-status-doc-3')).toHaveTextContent(
      'document.upload.dingtalk.importProcessing'
    )
    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-3'))
    mockSyncDocs.mockResolvedValue({})
    mockGetDocs.mockResolvedValue({ nodes: [...DOCS_TREE], total_count: 5 })
    mockGetExternalDocumentImportStatuses.mockResolvedValue({ 'doc-3': 'success' })
    fireEvent.click(screen.getByTestId('dingtalk-import-refresh'))
    await waitFor(() =>
      expect(screen.getByTestId('dingtalk-import-status-doc-3')).toHaveTextContent(
        'document.upload.dingtalk.imported'
      )
    )
    expect(screen.getByTestId('dingtalk-node-select-doc-3')).toHaveAttribute('aria-checked', 'true')
  })

  it.each(['123', 'https:example.com', 'ftp://example.com'])(
    'explains invalid URL %s after blur and clears the error when corrected',
    invalidUrl => {
      const onWebAdd = jest.fn()
      render(
        <DocumentUpload
          knowledgeBaseId={42}
          open={true}
          onOpenChange={jest.fn()}
          onUploadComplete={jest.fn()}
          onWebAdd={onWebAdd}
        />
      )
      fireEvent.mouseDown(screen.getByTestId('document-source-web'), { button: 0, ctrlKey: false })
      const input = screen.getByTestId('document-web-url')
      fireEvent.blur(input)
      expect(input).not.toHaveAttribute('aria-invalid', 'true')
      fireEvent.change(input, { target: { value: invalidUrl } })
      fireEvent.blur(input)
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAccessibleDescription('document.upload.web.invalidUrl')
      expect(screen.getByTestId('document-web-submit')).toBeDisabled()
      expect(onWebAdd).not.toHaveBeenCalled()
      fireEvent.change(input, { target: { value: 'https://example.com/article' } })
      expect(input).not.toHaveAttribute('aria-invalid', 'true')
      expect(screen.queryByText('document.upload.web.invalidUrl')).not.toBeInTheDocument()
      expect(screen.getByTestId('document-web-submit')).toBeEnabled()
    }
  )

  it('shows the dingtalk entry only when the handler is provided', () => {
    render(
      <DocumentUpload
        knowledgeBaseId={42}
        open={true}
        onOpenChange={jest.fn()}
        onUploadComplete={jest.fn()}
      />
    )

    expect(screen.queryByTestId('dingtalk-source-button')).not.toBeInTheDocument()

    render(
      <DocumentUpload
        knowledgeBaseId={42}
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

  it('shows the cached directory and reveals import details without refreshing it', async () => {
    await openDingtalkMode()

    expect(mockGetDocs).toHaveBeenCalled()
    expect(mockSyncDocs).not.toHaveBeenCalled()
    // Top level shows the folder and the standalone doc.
    expect(screen.getByTestId('dingtalk-folder-option-folder-1')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-document-option-doc-3')).toBeInTheDocument()
    expect(screen.queryByText('Pick DingTalk documents to import.')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-import-last-synced')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Import details' }))
    expect(await screen.findByText('Pick DingTalk documents to import.')).toBeVisible()
    expect(screen.getByTestId('dingtalk-import-last-synced')).toHaveTextContent('Last refreshed')
    expect(mockSyncDocs).not.toHaveBeenCalled()
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

  it('keeps expanded folders and siblings when refreshing succeeds but reloading fails', async () => {
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
    expect(screen.getByTestId('dingtalk-document-option-doc-3')).toBeInTheDocument()
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

  it('shows matching child documents nested under a document rather than a folder', async () => {
    const onDingtalkImport = jest.fn().mockResolvedValue({ createdCount: 1 })
    mockGetDocs.mockResolvedValue({
      nodes: [
        docNode('parent-doc', '无标题文档(3)', {
          children: [
            docNode('child-week', '8-12周执行版'),
            docNode('child-untitled', '无标题文档'),
          ],
        }),
      ],
      total_count: 3,
    })
    await openDingtalkMode({ onDingtalkImport })
    fireEvent.change(screen.getByTestId('dingtalk-import-search'), {
      target: { value: '8-12周执行版' },
    })
    expect(screen.getByTestId('dingtalk-document-option-parent-doc')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-document-option-child-week')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-option-child-untitled')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('dingtalk-import-select-all'))
    expect(screen.getByTestId('dingtalk-node-select-parent-doc')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))
    await waitFor(() => expect(onDingtalkImport).toHaveBeenCalledWith(['child-week']))
  })

  it('expands document children while selecting parent and child documents independently', async () => {
    const onDingtalkImport = jest.fn().mockResolvedValue({ createdCount: 1 })
    mockGetDocs.mockResolvedValue({
      nodes: [
        folderNode('folder-1', 'Project', [
          docNode('parent-doc', '无标题文档(3)', {
            children: [
              docNode('child-week', '8-12周执行版'),
              docNode('child-untitled', '无标题文档'),
            ],
          }),
        ]),
      ],
      total_count: 4,
    })
    await openDingtalkMode({ onDingtalkImport })
    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    expect(screen.queryByTestId('dingtalk-document-option-child-week')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('dingtalk-node-expand-parent-doc'))
    expect(screen.getByTestId('dingtalk-document-option-child-week')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-document-option-child-untitled')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 0')
    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 3')
    fireEvent.click(screen.getByTestId('dingtalk-node-select-parent-doc'))
    expect(screen.getByTestId('dingtalk-node-select-child-week')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 2')
    fireEvent.click(screen.getByTestId('dingtalk-node-select-child-untitled'))
    fireEvent.click(screen.getByTestId('dingtalk-node-expand-parent-doc'))
    expect(screen.queryByTestId('dingtalk-document-option-child-week')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))
    await waitFor(() => expect(onDingtalkImport).toHaveBeenCalledWith(['child-week']))
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

  it('hides empty folder arrows but keeps zero-importable folders with children expandable', async () => {
    mockGetDocs.mockResolvedValue({
      nodes: [
        folderNode('empty', 'Empty'),
        folderNode('parent', 'Parent', [folderNode('empty-child', 'Empty child')]),
        folderNode('files', 'Files', [
          makeNode({ dingtalk_node_id: 'unsupported', node_type: 'file' }),
        ]),
      ],
      total_count: 5,
    })
    await openDingtalkMode()
    expect(screen.queryByTestId('dingtalk-folder-navigate-empty')).not.toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-node-name-empty').previousElementSibling).toHaveClass(
      'h-11',
      'w-11',
      'shrink-0'
    )
    expect(screen.getByTestId('dingtalk-node-select-empty')).toBeDisabled()
    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-parent'))
    expect(screen.getByTestId('dingtalk-node-name-empty-child')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-folder-navigate-empty-child')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-files'))
    expect(screen.getByTestId('dingtalk-node-unsupported-unsupported')).toBeInTheDocument()
  })

  it('shows stable folder document totals across expansion, selection, and search', async () => {
    await openDingtalkMode()
    const total = screen.getByTestId('dingtalk-folder-document-count-folder-1')
    expect(screen.getByText('3 importable documents')).toBeInTheDocument()
    expect(total).toHaveTextContent('Importable: 2')
    expect(total).toHaveAttribute('title', 'Importable documents, including all descendants')

    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    expect(total).toHaveTextContent('Importable: 2')
    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-1'))
    expect(total).toHaveTextContent('Importable: 2')
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 1')
    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    expect(total).toHaveTextContent('Importable: 2')

    fireEvent.change(screen.getByTestId('dingtalk-import-search'), { target: { value: 'spec' } })
    expect(screen.queryByTestId('dingtalk-document-option-doc-2')).not.toBeInTheDocument()
    expect(screen.getByText('1 matching importable documents')).toBeInTheDocument()
    expect(total).toHaveTextContent('Importable: 2')
  })

  it('counts unique importable descendants regardless of import status and shows empty folders as zero', async () => {
    mockGetDocs.mockResolvedValue({
      nodes: [
        folderNode('folder-1', 'Project', [
          folderNode('nested', 'Nested', [docNode('doc-1', 'Spec Doc')]),
          docNode('doc-2', 'Parent Doc', {
            children: [docNode('doc-3', 'Child Doc'), docNode('doc-1', 'Spec Doc')],
          }),
          folderNode('empty', 'Empty'),
          folderNode('unsupported', 'Files', [makeNode({ node_type: 'file' })]),
        ]),
      ],
      total_count: 10,
    })
    mockGetExternalDocumentImportStatuses.mockResolvedValue({
      'doc-1': 'success',
      'doc-2': 'failed',
      'doc-3': 'indexing',
    })
    await openDingtalkMode()
    expect(screen.getByTestId('dingtalk-folder-document-count-folder-1')).toHaveTextContent(
      'Importable: 3'
    )
    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    expect(await screen.findByTestId('dingtalk-import-status-doc-2')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-folder-document-count-nested')).toHaveTextContent(
      'Importable: 1'
    )
    expect(screen.getByTestId('dingtalk-folder-document-count-empty')).toHaveTextContent(
      'Importable: 0'
    )
    expect(screen.getByTestId('dingtalk-folder-document-count-unsupported')).toHaveTextContent(
      'Importable: 0'
    )
    expect(screen.queryByTestId('dingtalk-folder-document-count-doc-2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 3')
    expect(screen.getByTestId('dingtalk-folder-document-count-folder-1')).toHaveTextContent(
      'Importable: 3'
    )
  })

  it('expands folders inline without selecting them or hiding sibling documents', async () => {
    await openDingtalkMode()

    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))

    expect(await screen.findByTestId('dingtalk-document-option-doc-1')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-document-option-doc-3')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 0')
    expect(screen.getByTestId('dingtalk-folder-navigate-folder-1')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('dingtalk-import-cancel')).toHaveClass('min-h-11')
    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    expect(screen.queryByTestId('dingtalk-document-option-doc-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-document-option-doc-3')).toBeInTheDocument()
  })

  it('selects only matching leaves while preserving their ancestors and the prior expansion state', async () => {
    const onDingtalkImport = jest
      .fn()
      .mockResolvedValue({ createdCount: 2, updatedCount: 0, processingCount: 0 })
    await openDingtalkMode({ onDingtalkImport })
    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-3'))
    fireEvent.change(screen.getByTestId('dingtalk-import-search'), { target: { value: 'spec' } })
    expect(screen.getByTestId('dingtalk-folder-option-folder-1')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-node-select-folder-1')).toBeDisabled()
    fireEvent.click(screen.getByTestId('dingtalk-import-select-all'))
    expect(screen.getByTestId('dingtalk-import-select-all')).toHaveTextContent(
      'Clear result selection'
    )
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 2')
    fireEvent.change(screen.getByTestId('dingtalk-import-search'), { target: { value: '' } })
    expect(screen.queryByTestId('dingtalk-document-option-doc-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-node-select-folder-1')).toHaveAttribute(
      'aria-checked',
      'mixed'
    )
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))
    await waitFor(() => expect(onDingtalkImport).toHaveBeenCalledWith(['doc-1', 'doc-3']))
  })

  it('keeps explicit selections on refresh without selecting new descendants and drops removed documents', async () => {
    await openDingtalkMode()
    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    mockSyncDocs.mockResolvedValue({ added: 1, updated: 0, deleted: 1, total: 3 })
    mockGetDocs.mockResolvedValue({
      nodes: [
        folderNode('folder-1', 'Project', [
          docNode('doc-2', 'API Doc'),
          docNode('doc-4', 'New Doc'),
        ]),
      ],
      total_count: 3,
    })
    fireEvent.click(screen.getByTestId('dingtalk-import-refresh'))
    await screen.findByTestId('dingtalk-document-option-doc-4')
    expect(screen.getByTestId('dingtalk-node-select-doc-4')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(screen.getByTestId('dingtalk-node-select-doc-2')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 1')
    expect(screen.getByTestId('dingtalk-node-select-folder-1')).toHaveAttribute(
      'aria-checked',
      'mixed'
    )
  })

  it('selects nested descendants and clears a fully selected subtree', async () => {
    mockGetDocs.mockResolvedValue({
      nodes: [
        folderNode('folder-1', 'Project', [
          folderNode('nested', 'Nested', [docNode('doc-1', 'Spec Doc')]),
          docNode('doc-2', 'API Doc'),
        ]),
      ],
      total_count: 4,
    })
    await openDingtalkMode()
    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    expect(screen.getByTestId('dingtalk-node-select-nested')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    fireEvent.click(screen.getByTestId('dingtalk-node-select-nested'))
    expect(screen.getByTestId('dingtalk-node-select-folder-1')).toHaveAttribute(
      'aria-checked',
      'mixed'
    )
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 1')
    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 0')
    expect(screen.getByTestId('dingtalk-import-submit')).toBeDisabled()
  })

  it('allows excluding a child from a selected folder and submits only the remaining documents', async () => {
    const onDingtalkImport = jest
      .fn()
      .mockResolvedValue({ createdCount: 1, updatedCount: 0, processingCount: 0 })
    await openDingtalkMode({ onDingtalkImport })

    // Folder selection includes both importable children, not the unsupported file.
    fireEvent.click(screen.getByTestId('dingtalk-node-select-folder-1'))
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 2')

    fireEvent.click(screen.getByTestId('dingtalk-folder-navigate-folder-1'))
    expect(screen.getByTestId('dingtalk-node-select-doc-1')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(await screen.findByTestId('dingtalk-node-select-doc-1'))
    expect(screen.getByTestId('dingtalk-import-selected-count')).toHaveTextContent('Selected: 1')
    expect(screen.getByTestId('dingtalk-node-select-folder-1')).toHaveAttribute(
      'aria-checked',
      'mixed'
    )
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))
    await waitFor(() => expect(onDingtalkImport).toHaveBeenCalledWith(['doc-2']))
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

  it('keeps the import limit and target permissions visible beside one details entry', async () => {
    await openDingtalkMode()

    expect(screen.getByText('Up to 50 per import', { exact: false })).toBeVisible()
    expect(screen.getByTestId('dingtalk-import-shared-hint')).toHaveTextContent(
      'Imported content uses target knowledge base permissions'
    )
    expect(screen.getByTestId('dingtalk-import-shared-hint')).toBeVisible()
    expect(screen.getAllByTestId('dingtalk-import-help')).toHaveLength(1)
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
        knowledgeBaseId={42}
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

  it('refreshes import status after completion when another source still has a draft', async () => {
    await openDingtalkMode({
      onDingtalkImport: jest.fn().mockImplementation(async () => {
        mockGetExternalDocumentImportStatuses.mockResolvedValue({ 'doc-3': 'queued' })
        return { createdCount: 1, updatedCount: 0, processingCount: 0 }
      }),
    })
    fireEvent.mouseDown(screen.getByTestId('document-source-text'), { button: 0, ctrlKey: false })
    fireEvent.change(screen.getByTestId('document-text-content'), {
      target: { value: 'Unsaved draft' },
    })
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))
    fireEvent.click(screen.getByTestId('dingtalk-node-select-doc-3'))
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))
    fireEvent.click(await screen.findByTestId('dingtalk-import-done'))
    expect(await screen.findByTestId('dingtalk-import-status-doc-3')).toHaveTextContent(
      'document.upload.dingtalk.importProcessing'
    )
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

  it.each([
    ['conflict', 'Failed to import'],
    [
      new Error(
        'DingTalk Table MCP is not configured or not enabled. Configure it in Settings > Integrations.'
      ),
      'Configure and enable DingTalk Table MCP in Settings > Integrations first.',
    ],
  ])(
    'keeps the dialog open and shows the error when the import fails (%s)',
    async (error, message) => {
      mockGetDocs.mockResolvedValue({ nodes: [docNode('doc-9', 'Failing Doc')], total_count: 1 })
      const onDingtalkImport = jest.fn().mockRejectedValue(error)

      render(
        <DocumentUpload
          knowledgeBaseId={42}
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
      expect(await screen.findByTestId('dingtalk-import-error')).toHaveTextContent(
        message as string
      )
      expect(screen.queryByTestId('dingtalk-import-result')).not.toBeInTheDocument()
    }
  )

  it.each(['docs', 'wikispace'])('offers configuration for unavailable %s', async source => {
    mockGetSyncStatus.mockResolvedValue({ is_configured: false, total_nodes: 0 })
    mockGetWikispaceSyncStatus.mockResolvedValue({ is_configured: false, total_nodes: 0 })

    render(
      <DocumentUpload
        knowledgeBaseId={42}
        open={true}
        onOpenChange={jest.fn()}
        onUploadComplete={jest.fn()}
        onDingtalkImport={jest.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))
    if (source === 'wikispace') {
      fireEvent.click(await screen.findByTestId('dingtalk-import-tab-wikispace'))
    }

    expect(
      await screen.findByText(
        source === 'docs'
          ? 'DingTalk Docs is not configured'
          : 'Configure and enable both DingTalk Docs and DingTalk Knowledge Base to use this directory.'
      )
    ).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-go-to-settings-button')).toHaveAttribute(
      'href',
      '/settings?tab=integrations'
    )
    expect(screen.queryByTestId('dingtalk-import-refresh')).not.toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-import-submit')).toBeDisabled()
    expect(screen.queryByTestId('dingtalk-document-list')).not.toBeInTheDocument()
    expect(mockGetDocs).not.toHaveBeenCalled()
    expect(mockGetWikispaceNodes).not.toHaveBeenCalled()
  })
})
