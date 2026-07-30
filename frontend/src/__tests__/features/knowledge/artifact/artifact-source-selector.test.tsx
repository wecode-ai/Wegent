// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactSourceSelector } from '@/features/knowledge/artifact/components/ArtifactSourceSelector'
import { useDocuments } from '@/features/knowledge/document/hooks/useDocuments'
import type { KnowledgeDocument } from '@/types/knowledge'

const refreshMock = jest.fn()

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) =>
      params?.count === undefined ? key : `${key}:${params.count}`,
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useDocuments', () => ({
  useDocuments: jest.fn(),
}))

const createDocument = (
  id: number,
  overrides: Partial<KnowledgeDocument> = {}
): KnowledgeDocument => ({
  id,
  kind_id: 1,
  attachment_id: 1,
  name: `document-${id}.pdf`,
  file_extension: 'pdf',
  file_size: 100,
  status: 'enabled',
  user_id: 7,
  is_active: true,
  index_status: 'success',
  index_generation: 1,
  source_type: 'file',
  source_config: {},
  folder_id: 0,
  created_at: '2026-07-26T00:00:00Z',
  updated_at: '2026-07-26T00:00:00Z',
  ...overrides,
})

describe('ArtifactSourceSelector', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useDocuments as jest.Mock).mockReturnValue({
      documents: [createDocument(11), createDocument(12, { index_status: 'indexing' })],
      loading: false,
      error: null,
      page: 1,
      pageSize: 100,
      totalCount: 2,
      totalPages: 1,
      goToPage: jest.fn(),
      changePageSize: jest.fn(),
      refresh: refreshMock,
    })
  })

  it('browses documents and selects only available sources from the inline view', () => {
    const onScopeChange = jest.fn()
    const onOpenDocument = jest.fn()

    render(
      <ArtifactSourceSelector
        knowledgeBaseId={12}
        scope={{ mode: 'all' }}
        availableDocumentCount={1}
        compact
        onScopeChange={onScopeChange}
        onOpenDocument={onOpenDocument}
      />
    )

    expect(screen.getByText('artifact.sourceDialog.all')).toBeInTheDocument()
    expect(screen.queryByTestId('artifact-source-all')).not.toBeInTheDocument()
    expect(screen.queryByTestId('artifact-source-open-document-11')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('artifact-source-selected'))
    fireEvent.click(screen.getByTestId('artifact-source-open-document-11'))
    expect(onOpenDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }))

    fireEvent.click(screen.getByTestId('artifact-source-document-11'))
    expect(onScopeChange).toHaveBeenCalledWith({
      mode: 'selected',
      documentIds: new Set([11]),
    })
    expect(screen.getByTestId('artifact-source-document-12')).toBeDisabled()
  })

  it('refreshes document status when the available source count changes', () => {
    const props = {
      knowledgeBaseId: 12,
      scope: { mode: 'all' as const },
      availableDocumentCount: 1,
      compact: true,
      onScopeChange: jest.fn(),
    }
    const { rerender } = render(<ArtifactSourceSelector {...props} />)

    fireEvent.click(screen.getByTestId('artifact-source-selected'))
    expect(refreshMock).not.toHaveBeenCalled()
    rerender(<ArtifactSourceSelector {...props} availableDocumentCount={2} />)

    expect(refreshMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes an expanded source list immediately after adding a source', () => {
    const props = {
      knowledgeBaseId: 12,
      scope: { mode: 'all' as const },
      availableDocumentCount: 1,
      compact: true,
      defaultDocumentsExpanded: true,
      refreshToken: 0,
      onScopeChange: jest.fn(),
    }
    const { rerender } = render(<ArtifactSourceSelector {...props} />)

    refreshMock.mockClear()
    rerender(<ArtifactSourceSelector {...props} refreshToken={1} />)

    expect(refreshMock).toHaveBeenCalledTimes(1)
  })

  it('resets the compact browser when the knowledge base changes', () => {
    const props = {
      knowledgeBaseId: 12,
      scope: { mode: 'all' as const },
      availableDocumentCount: 1,
      compact: true,
      onScopeChange: jest.fn(),
    }
    const { rerender } = render(<ArtifactSourceSelector {...props} />)

    fireEvent.click(screen.getByTestId('artifact-source-selected'))
    fireEvent.change(screen.getByTestId('artifact-source-search'), {
      target: { value: 'report' },
    })
    rerender(<ArtifactSourceSelector {...props} knowledgeBaseId={13} />)

    expect(screen.queryByTestId('artifact-source-search')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('artifact-source-selected'))
    expect(screen.getByTestId('artifact-source-search')).toHaveValue('')
  })

  it('expands by default for read-only users without overriding manual changes', async () => {
    const props = {
      knowledgeBaseId: 12,
      scope: { mode: 'all' as const },
      availableDocumentCount: 1,
      compact: true,
      onScopeChange: jest.fn(),
    }
    const { rerender } = render(<ArtifactSourceSelector {...props} />)

    expect(screen.queryByTestId('artifact-source-search')).not.toBeInTheDocument()
    rerender(<ArtifactSourceSelector {...props} defaultDocumentsExpanded />)
    await waitFor(() => expect(screen.getByTestId('artifact-source-search')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('artifact-source-selected'))
    expect(screen.queryByTestId('artifact-source-search')).not.toBeInTheDocument()
    rerender(<ArtifactSourceSelector {...props} defaultDocumentsExpanded={false} />)
    expect(screen.queryByTestId('artifact-source-search')).not.toBeInTheDocument()
  })

  it('lets read-only users select documents for questions and preview other documents', () => {
    const onScopeChange = jest.fn()
    const onOpenDocument = jest.fn()

    const props = {
      knowledgeBaseId: 12,
      availableDocumentCount: 1,
      compact: true,
      purpose: 'question' as const,
      defaultDocumentsExpanded: true,
      onScopeChange,
      onOpenDocument,
    }
    const { rerender } = render(<ArtifactSourceSelector {...props} scope={{ mode: 'all' }} />)

    expect(screen.getByTestId('artifact-source-document-11')).toBeEnabled()
    expect(screen.getByTestId('artifact-source-document-12')).toBeDisabled()

    fireEvent.click(screen.getByTestId('artifact-source-open-document-12'))
    expect(onOpenDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 12 }))
    fireEvent.click(screen.getByTestId('artifact-source-document-11'))
    expect(onScopeChange).toHaveBeenCalledWith({
      mode: 'selected',
      documentIds: new Set([11]),
    })

    rerender(
      <ArtifactSourceSelector {...props} scope={{ mode: 'selected', documentIds: new Set([11]) }} />
    )
    expect(screen.getByText('artifact.sourceBrowser.questionHint')).toBeInTheDocument()
  })

  it('requests documents only after the browser expands', () => {
    const props = {
      knowledgeBaseId: 12,
      scope: { mode: 'all' as const },
      availableDocumentCount: 1,
      compact: true,
      onScopeChange: jest.fn(),
    }

    render(<ArtifactSourceSelector {...props} />)
    expect(useDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        autoLoad: false,
        serverPaginationOnly: true,
        initialPageSize: 10,
      })
    )

    fireEvent.click(screen.getByTestId('artifact-source-selected'))
    expect(useDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        autoLoad: true,
        serverPaginationOnly: true,
      })
    )
  })

  it('falls back to the whole knowledge base after removing the final selection', () => {
    const onScopeChange = jest.fn()

    render(
      <ArtifactSourceSelector
        knowledgeBaseId={12}
        scope={{ mode: 'selected', documentIds: new Set([11]) }}
        availableDocumentCount={1}
        compact
        defaultDocumentsExpanded
        onScopeChange={onScopeChange}
      />
    )

    fireEvent.click(screen.getByTestId('artifact-source-document-11'))
    expect(onScopeChange).toHaveBeenCalledWith({ mode: 'all' })
  })

  it('refreshes an expanded browser on focus and while documents are processing', () => {
    jest.useFakeTimers()
    const { unmount } = render(
      <ArtifactSourceSelector
        knowledgeBaseId={12}
        scope={{ mode: 'all' }}
        availableDocumentCount={1}
        processingDocumentCount={1}
        compact
        defaultDocumentsExpanded
        onScopeChange={jest.fn()}
      />
    )

    refreshMock.mockClear()
    act(() => window.dispatchEvent(new Event('focus')))
    expect(refreshMock).toHaveBeenCalledTimes(1)

    refreshMock.mockClear()
    act(() => jest.advanceTimersByTime(5000))
    expect(refreshMock).toHaveBeenCalledTimes(1)

    unmount()
    jest.useRealTimers()
  })
})
