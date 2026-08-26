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

jest.mock('@/apis/dingtalk-doc', () => ({
  dingtalkDocApi: {
    getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
    getDocs: (...args: unknown[]) => mockGetDocs(...args),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'document.document.upload': 'Upload documents',
        'document.document.dropzone': 'Drop files here',
        'document.upload.uploadFile': 'Upload file',
        'document.upload.pasteText': 'Paste text',
        'document.upload.dingtalk.entry': 'DingTalk document',
        'document.upload.dingtalk.title': 'Import a DingTalk document',
        'document.upload.dingtalk.hint': 'Pick one DingTalk document.',
        'document.upload.dingtalk.loading': 'Loading DingTalk documents...',
        'document.upload.dingtalk.notConfigured': 'DingTalk Docs is not configured',
        'document.upload.dingtalk.empty': 'No importable documents',
        'document.upload.dingtalk.loadFailed': 'Failed to load',
        'document.upload.dingtalk.addFailed': 'Failed to import',
        'document.upload.dingtalk.submitButton': 'Import',
        'document.upload.adding': 'Adding...',
        'common:actions.cancel': 'Cancel',
      }

      return translations[key] ?? key
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

function renderUpload(props: Partial<Parameters<typeof DocumentUpload>[0]> = {}) {
  return render(
    <DocumentUpload open={true} onOpenChange={jest.fn()} onUploadComplete={jest.fn()} {...props} />
  )
}

describe('DocumentUpload dingtalk source', () => {
  beforeEach(() => {
    mockUseBatchAttachment.mockReset()
    mockGetSyncStatus.mockReset()
    mockGetDocs.mockReset()
    setupBatchAttachment()
  })

  it('shows the dingtalk entry only when the handler is provided', () => {
    renderUpload()

    expect(screen.queryByTestId('dingtalk-source-button')).not.toBeInTheDocument()

    renderUpload({ onDingtalkAdd: jest.fn() })

    expect(screen.getByTestId('dingtalk-source-button')).toBeInTheDocument()
  })

  it('lists only importable doc nodes after loading', async () => {
    mockGetSyncStatus.mockResolvedValue({ is_configured: true, total_nodes: 3 })
    mockGetDocs.mockResolvedValue({
      nodes: [
        makeNode({ id: 1, dingtalk_node_id: 'folder-1', name: 'Folder', node_type: 'folder' }),
        makeNode({
          id: 2,
          dingtalk_node_id: 'doc-nested',
          name: 'Nested Doc',
          node_type: 'doc',
          children: [makeNode({ id: 3, dingtalk_node_id: 'doc-leaf', name: 'Leaf Doc' })],
        }),
      ],
      total_count: 3,
    })

    renderUpload({ onDingtalkAdd: jest.fn() })
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))

    await waitFor(() => expect(mockGetDocs).toHaveBeenCalled())
    expect(await screen.findByTestId('dingtalk-document-list')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-document-option-doc-nested')).toBeInTheDocument()
    expect(screen.getByTestId('dingtalk-document-option-doc-leaf')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-option-folder-1')).not.toBeInTheDocument()
  })

  it('shows the not-configured hint instead of the list', async () => {
    mockGetSyncStatus.mockResolvedValue({ is_configured: false, total_nodes: 0 })

    renderUpload({ onDingtalkAdd: jest.fn() })
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))

    await waitFor(() => expect(mockGetSyncStatus).toHaveBeenCalled())
    expect(await screen.findByText('DingTalk Docs is not configured')).toBeInTheDocument()
    expect(screen.queryByTestId('dingtalk-document-list')).not.toBeInTheDocument()
    expect(mockGetDocs).not.toHaveBeenCalled()
  })

  it('submits the selected document through the callback', async () => {
    mockGetSyncStatus.mockResolvedValue({ is_configured: true, total_nodes: 1 })
    mockGetDocs.mockResolvedValue({
      nodes: [makeNode({ id: 2, dingtalk_node_id: 'doc-1', name: 'Spec Doc' })],
      total_count: 1,
    })
    const onDingtalkAdd = jest.fn().mockResolvedValue(undefined)
    const onOpenChange = jest.fn()

    render(
      <DocumentUpload
        open={true}
        onOpenChange={onOpenChange}
        onUploadComplete={jest.fn()}
        onDingtalkAdd={onDingtalkAdd}
      />
    )
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))
    fireEvent.click(await screen.findByTestId('dingtalk-document-option-doc-1'))

    const submit = screen.getByTestId('dingtalk-import-submit')
    expect(submit).not.toBeDisabled()
    fireEvent.click(submit)

    await waitFor(() => expect(onDingtalkAdd).toHaveBeenCalledTimes(1))
    expect(onDingtalkAdd).toHaveBeenCalledWith(
      expect.objectContaining({ dingtalk_node_id: 'doc-1', name: 'Spec Doc' })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the dialog open and shows the error when the import fails', async () => {
    mockGetSyncStatus.mockResolvedValue({ is_configured: true, total_nodes: 1 })
    mockGetDocs.mockResolvedValue({
      nodes: [makeNode({ id: 2, dingtalk_node_id: 'doc-1', name: 'Spec Doc' })],
      total_count: 1,
    })
    const onDingtalkAdd = jest.fn().mockRejectedValue('conflict')
    const onOpenChange = jest.fn()

    render(
      <DocumentUpload
        open={true}
        onOpenChange={onOpenChange}
        onUploadComplete={jest.fn()}
        onDingtalkAdd={onDingtalkAdd}
      />
    )
    fireEvent.click(screen.getByTestId('dingtalk-source-button'))
    fireEvent.click(await screen.findByTestId('dingtalk-document-option-doc-1'))
    fireEvent.click(screen.getByTestId('dingtalk-import-submit'))

    await waitFor(() => expect(onDingtalkAdd).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Failed to import')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
