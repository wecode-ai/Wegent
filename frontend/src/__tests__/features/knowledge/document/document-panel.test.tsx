// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DocumentPanel } from '@/features/knowledge/document/components/DocumentPanel'
import type { KnowledgeBase, KnowledgeDocument } from '@/types/knowledge'

const mockDocumentDetailDialog = jest.fn((_props: unknown) => null)
const mockArtifactSourceSelector = jest.fn((_props: unknown) => null)
const mockSourceContinuation = jest.fn()
const mockCreateDocument = jest.fn()
const mockFindDocumentByName = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactPanel', () => ({
  ArtifactPanel: ({
    onCanManageChange,
    onAdjustSources,
  }: {
    onCanManageChange?: (canManage: boolean) => void
    onAdjustSources: (continuation: () => void) => void
  }) => (
    <>
      <button data-testid="mock-read-only-permission" onClick={() => onCanManageChange?.(false)} />
      <button data-testid="mock-editor-permission" onClick={() => onCanManageChange?.(true)} />
      <button
        data-testid="mock-adjust-sources"
        onClick={() => onAdjustSources(mockSourceContinuation)}
      />
    </>
  ),
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactSourceDialog', () => ({
  ArtifactSourceDialog: ({
    open,
    onOpenChange,
    onApply,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onApply: (documentIds: number[]) => void
  }) =>
    open ? (
      <>
        <button data-testid="mock-source-cancel" onClick={() => onOpenChange(false)} />
        <button data-testid="mock-source-apply" onClick={() => onApply([11])} />
      </>
    ) : null,
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactSourceSelector', () => ({
  ArtifactSourceSelector: (props: unknown) => mockArtifactSourceSelector(props),
}))

jest.mock('@/features/knowledge/document/components/DocumentUpload', () => ({
  DocumentUpload: ({
    open,
    onTableAdd,
  }: {
    open: boolean
    onTableAdd?: (data: { name: string; source_config: { url: string } }) => Promise<void>
  }) =>
    open ? (
      <button
        data-testid="mock-table-add"
        onClick={() =>
          void onTableAdd?.({
            name: 'Sales table',
            source_config: { url: 'https://example.com/table' },
          })
        }
      />
    ) : null,
}))

jest.mock('@/features/knowledge/document/components/DocumentDetailDialog', () => ({
  DocumentDetailDialog: (props: unknown) => mockDocumentDetailDialog(props),
}))

jest.mock('@/features/knowledge/document/hooks/useDocuments', () => ({
  useDocuments: () => ({
    create: mockCreateDocument,
  }),
}))

jest.mock('@/features/knowledge/document/utils/document-lookup', () => ({
  findDocumentByName: (...args: unknown[]) => mockFindDocumentByName(...args),
}))

jest.mock('@/features/knowledge/multimodal/hooks/useModelSupportsVideo', () => ({
  useModelSupportsVideo: () => true,
}))

jest.mock('@/apis/knowledge', () => ({
  createWebDocument: jest.fn(),
}))

const knowledgeBase: KnowledgeBase = {
  id: 12,
  name: 'organization-kb',
  description: null,
  user_id: 7,
  namespace: 'organization-name',
  document_count: 3,
  is_active: true,
  summary_enabled: false,
  max_calls_per_conversation: 10,
  exempt_calls_before_check: 0,
  created_at: '2026-07-27T00:00:00Z',
  updated_at: '2026-07-27T00:00:00Z',
}

describe('DocumentPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    mockCreateDocument.mockResolvedValue({ id: 21 })
    mockFindDocumentByName.mockResolvedValue(undefined)
  })

  it('forwards organization routing context to document preview', () => {
    render(<DocumentPanel knowledgeBase={knowledgeBase} isOrganization canManageDocuments />)

    expect(mockDocumentDetailDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isOrganization: true,
        knowledgeBaseName: 'organization-kb',
        knowledgeBaseNamespace: 'organization-name',
        canEdit: true,
      })
    )
  })

  it('shows direct source upload only to document editors', () => {
    const { rerender } = render(<DocumentPanel knowledgeBase={knowledgeBase} />)

    expect(screen.queryByTestId('artifact-add-source')).not.toBeInTheDocument()

    rerender(<DocumentPanel knowledgeBase={knowledgeBase} canManageDocuments />)
    fireEvent.click(screen.getByTestId('artifact-add-source'))

    expect(screen.getByTestId('mock-table-add')).toBeInTheDocument()
  })

  it('creates quick-added sources in the knowledge base root', async () => {
    render(<DocumentPanel knowledgeBase={knowledgeBase} canManageDocuments />)

    fireEvent.click(screen.getByTestId('artifact-add-source'))
    fireEvent.click(screen.getByTestId('mock-table-add'))

    await waitFor(() =>
      expect(mockCreateDocument).toHaveBeenCalledWith({
        name: 'Sales table',
        file_extension: 'table',
        file_size: 0,
        source_type: 'table',
        source_config: { url: 'https://example.com/table' },
        folder_id: 0,
      })
    )
  })

  it('opens a document path directly in the workshop preview', async () => {
    const document = {
      id: 31,
      name: 'guide.md',
    } as KnowledgeDocument
    mockFindDocumentByName.mockResolvedValue(document)

    render(<DocumentPanel knowledgeBase={knowledgeBase} initialDocPath="guide.md" />)

    await waitFor(() =>
      expect(mockDocumentDetailDialog).toHaveBeenLastCalledWith(
        expect.objectContaining({
          document,
        })
      )
    )
    expect(mockFindDocumentByName).toHaveBeenCalledWith(
      knowledgeBase.id,
      'guide.md',
      expect.any(AbortSignal)
    )
  })

  it('expands sources by default only for read-only users', () => {
    render(<DocumentPanel knowledgeBase={knowledgeBase} />)

    expect(mockArtifactSourceSelector).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultDocumentsExpanded: undefined })
    )

    fireEvent.click(screen.getByTestId('mock-read-only-permission'))
    expect(mockArtifactSourceSelector).toHaveBeenLastCalledWith(
      expect.objectContaining({
        defaultDocumentsExpanded: true,
        purpose: 'question',
      })
    )
    expect(screen.getByText('artifact.sourceBrowser.documents')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('mock-editor-permission'))
    expect(mockArtifactSourceSelector).toHaveBeenLastCalledWith(
      expect.objectContaining({
        defaultDocumentsExpanded: false,
        purpose: 'workspace',
      })
    )
    expect(screen.getByText('artifact.source')).toBeInTheDocument()
  })

  it('resumes creation only after applying source changes', () => {
    render(<DocumentPanel knowledgeBase={knowledgeBase} />)

    fireEvent.click(screen.getByTestId('mock-adjust-sources'))
    fireEvent.click(screen.getByTestId('mock-source-cancel'))
    expect(mockSourceContinuation).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('mock-adjust-sources'))
    fireEvent.click(screen.getByTestId('mock-source-apply'))
    expect(mockSourceContinuation).toHaveBeenCalledTimes(1)
  })
})
