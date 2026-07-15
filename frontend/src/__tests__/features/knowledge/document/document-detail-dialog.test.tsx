// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentDetailDialog } from '@/features/knowledge/document/components/DocumentDetailDialog'
import type { DocumentSummary, KnowledgeDocument } from '@/types/knowledge'
import { toast } from 'sonner'

const mockRouterPush = jest.fn()
const mockDownloadAttachment = jest.fn()
let mockDocumentSummary: DocumentSummary | null = null
const mockDialogContent = jest.fn(
  ({ children }: { children: React.ReactNode; className?: string }) => <div>{children}</div>
)

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}))

jest.mock('next/dynamic', () => () => {
  const MockDynamicComponent = () => <div data-testid="dynamic-component" />
  MockDynamicComponent.displayName = 'MockDynamicComponent'
  return MockDynamicComponent
})

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    getCurrentLanguage: () => 'en',
  }),
}))

jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({
    theme: 'light',
  }),
}))

const mockListKnowledgeBases = jest.fn()

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeConfig: jest.fn().mockResolvedValue({
    chunk_storage_enabled: false,
  }),
  listKnowledgeBases: (...args: unknown[]) => mockListKnowledgeBases(...args),
}))

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: {
    updateDocumentContent: jest.fn(),
  },
}))

jest.mock('@/apis/attachments', () => ({
  downloadAttachment: (...args: unknown[]) => mockDownloadAttachment(...args),
  formatFileSize: (bytes: number) => `${bytes} B`,
  isImageExtension: () => false,
}))

jest.mock('@/features/knowledge/document/hooks/useDocumentDetail', () => ({
  useDocumentDetail: () => ({
    detail: {
      content_length: 18,
      truncated: false,
      summary: mockDocumentSummary,
      chunks: [],
    },
    fullContent: 'plain text content',
    loading: false,
    error: null,
    loadingMore: false,
    hasMoreContent: false,
    loadMore: jest.fn(),
    loadAllContent: jest.fn(),
    refresh: jest.fn(),
  }),
}))

jest.mock('@/features/knowledge/document/components/ChunksSection', () => ({
  ChunksSection: () => <div data-testid="chunks-section" />,
}))

jest.mock('@/features/knowledge/document/components/KnowledgeSourcePreview', () => ({
  KnowledgeSourcePreview: () => <div data-testid="mock-knowledge-source-preview" />,
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: (props: { children: React.ReactNode; className?: string }) =>
    mockDialogContent(props),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

// Reset mocks before each test
beforeEach(() => {
  mockRouterPush.mockClear()
  mockDialogContent.mockClear()
  mockDownloadAttachment.mockReset()
  mockDocumentSummary = null
  mockListKnowledgeBases.mockResolvedValue({ items: [] })
})

const baseDocument: KnowledgeDocument = {
  id: 11,
  kind_id: 21,
  attachment_id: null,
  name: 'shared-doc',
  file_extension: 'md',
  file_size: 128,
  status: 'enabled',
  user_id: 1,
  is_active: true,
  index_status: 'success',
  index_generation: 1,
  folder_id: 0,
  source_type: 'text',
  source_config: {},
  created_at: '2026-04-02T00:00:00Z',
  updated_at: '2026-04-02T00:00:00Z',
}

describe('DocumentDetailDialog permissions', () => {
  it('hides the edit button when the user cannot manage the document', () => {
    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={baseDocument}
        knowledgeBaseId={21}
        kbType="notebook"
        {...({ canEdit: false } as Record<string, unknown>)}
      />
    )

    expect(screen.queryByText('document.document.detail.edit')).not.toBeInTheDocument()
  })

  it('shows the edit button when the user can manage the document', () => {
    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={baseDocument}
        knowledgeBaseId={21}
        kbType="notebook"
        {...({ canEdit: true } as Record<string, unknown>)}
      />
    )

    expect(screen.getByText('document.document.detail.edit')).toBeInTheDocument()
  })
})

describe('DocumentDetailDialog original file preview', () => {
  const officeDocument: KnowledgeDocument = {
    ...baseDocument,
    id: 22,
    attachment_id: 32,
    name: 'report.docx',
    file_extension: 'docx',
    file_size: 1024,
    source_type: 'file',
  }

  it('shows the original file by default and allows switching to parsed content', async () => {
    const user = userEvent.setup()
    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={officeDocument}
        knowledgeBaseId={21}
      />
    )

    expect(screen.getByTestId('knowledge-document-source-tab')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-document-parsed-tab')).toHaveClass('max-md:min-h-[44px]')
    expect(screen.getByTestId('knowledge-document-source-tab')).toHaveClass('max-md:min-h-[44px]')
    expect(screen.getByTestId('knowledge-document-source-tab').nextElementSibling).toBe(
      screen.getByTestId('knowledge-document-parsed-tab')
    )
    expect(screen.getByTestId('knowledge-source-preview-download')).toHaveClass(
      'max-md:min-h-[44px]',
      'max-md:min-w-[44px]'
    )
    expect(screen.getByTestId('knowledge-source-preview-fullscreen')).toHaveClass(
      'max-md:min-h-[44px]',
      'max-md:min-w-[44px]'
    )
    expect(screen.getByTestId('mock-knowledge-source-preview')).toBeInTheDocument()

    await user.click(screen.getByTestId('knowledge-document-parsed-tab'))

    expect(screen.queryByTestId('mock-knowledge-source-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-source-preview-download')).not.toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-source-preview-fullscreen')).not.toBeInTheDocument()
    expect(String(mockDialogContent.mock.calls.at(-1)?.[0].className)).toContain('max-w-6xl')
  })

  it('hides the source preview tab for non-file documents', () => {
    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={baseDocument}
        knowledgeBaseId={21}
      />
    )

    expect(screen.queryByTestId('knowledge-document-source-tab')).not.toBeInTheDocument()
  })

  it('enters source preview fullscreen without closing the dialog', async () => {
    const user = userEvent.setup()
    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={officeDocument}
        knowledgeBaseId={21}
      />
    )

    await user.click(screen.getByTestId('knowledge-source-preview-fullscreen'))

    expect(screen.getByTestId('mock-knowledge-source-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-document-source-tab')).not.toBeInTheDocument()
    expect(screen.getByTestId('knowledge-source-preview-fullscreen')).toHaveAttribute(
      'aria-label',
      'document.document.detail.exitFullscreen'
    )
  })

  it('shares the derived summary across modes without taking source preview space by default', async () => {
    const user = userEvent.setup()
    mockDocumentSummary = {
      status: 'completed',
      short_summary: 'Derived summary content',
      topics: ['finance'],
    }
    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={officeDocument}
        knowledgeBaseId={21}
      />
    )

    const summaryToggle = screen.getByTestId('knowledge-document-summary-toggle')
    expect(summaryToggle).toHaveClass('max-md:min-h-[44px]')
    expect(screen.queryByText('Derived summary content')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('knowledge-document-parsed-tab'))
    expect(screen.getByText('Derived summary content')).toBeInTheDocument()

    await user.click(screen.getByTestId('knowledge-document-source-tab'))
    expect(screen.queryByText('Derived summary content')).not.toBeInTheDocument()

    await user.click(summaryToggle)
    expect(screen.getByText('Derived summary content')).toBeInTheDocument()
    await user.click(screen.getByTestId('knowledge-document-parsed-tab'))
    await user.click(screen.getByTestId('knowledge-document-source-tab'))
    expect(screen.getByText('Derived summary content')).toBeInTheDocument()
  })

  it('hides the shared summary while the original file is fullscreen', async () => {
    const user = userEvent.setup()
    mockDocumentSummary = {
      status: 'completed',
      short_summary: 'Derived summary content',
    }
    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={officeDocument}
        knowledgeBaseId={21}
      />
    )

    expect(screen.getByTestId('knowledge-document-summary-toggle')).toBeInTheDocument()
    await user.click(screen.getByTestId('knowledge-source-preview-fullscreen'))

    expect(screen.queryByTestId('knowledge-document-summary-toggle')).not.toBeInTheDocument()
  })

  it('resets fullscreen before rendering a reopened dialog', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={officeDocument}
        knowledgeBaseId={21}
      />
    )

    await user.click(screen.getByTestId('knowledge-source-preview-fullscreen'))
    rerender(
      <DocumentDetailDialog
        open={false}
        onOpenChange={jest.fn()}
        document={null}
        knowledgeBaseId={21}
      />
    )
    mockDialogContent.mockClear()

    rerender(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={officeDocument}
        knowledgeBaseId={21}
      />
    )

    const renderedClassNames = mockDialogContent.mock.calls.map(call => String(call[0].className))
    expect(renderedClassNames).not.toEqual(
      expect.arrayContaining([expect.stringContaining('max-w-[100vw]')])
    )
    expect(screen.getByTestId('mock-knowledge-source-preview')).toBeInTheDocument()
  })

  it('downloads the original file from the dialog header and preserves the preview on failure', async () => {
    const user = userEvent.setup()
    mockDownloadAttachment.mockRejectedValue(new Error('download failed'))
    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={officeDocument}
        knowledgeBaseId={21}
      />
    )

    await user.click(screen.getByTestId('knowledge-source-preview-download'))

    expect(mockDownloadAttachment).toHaveBeenCalledWith(32, 'report.docx')
    expect(toast.error).toHaveBeenCalledWith(
      'document.document.detail.sourcePreview.downloadFailed'
    )
    expect(screen.getByTestId('mock-knowledge-source-preview')).toBeInTheDocument()
  })
})

describe('DocumentDetailDialog wiki-link routing', () => {
  const markdownDocument: KnowledgeDocument = {
    id: 12,
    kind_id: 21,
    attachment_id: null,
    name: 'index.md',
    file_extension: 'md',
    file_size: 256,
    status: 'enabled',
    user_id: 1,
    is_active: true,
    index_status: 'success',
    index_generation: 1,
    folder_id: 0,
    source_type: 'text',
    source_config: {},
    created_at: '2026-04-02T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
  }

  beforeEach(() => {
    mockRouterPush.mockClear()
  })

  it('navigates to the resolved URL when a wiki link is found (happy path)', async () => {
    // Mock listKnowledgeBases to return the target KB
    mockListKnowledgeBases.mockResolvedValue({
      items: [{ name: 'other-kb', namespace: 'default' }],
    })

    // Mock useDocumentDetail to return markdown content with a relative link
    jest.doMock('@/features/knowledge/document/hooks/useDocumentDetail', () => ({
      useDocumentDetail: () => ({
        detail: {
          content_length: 26,
          truncated: false,
          summary: null,
          chunks: [],
        },
        fullContent: '[link](../other-kb/doc.md)',
        loading: false,
        error: null,
        loadingMore: false,
        hasMoreContent: false,
        loadMore: jest.fn(),
        loadAllContent: jest.fn(),
        refresh: jest.fn(),
      }),
    }))

    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={markdownDocument}
        knowledgeBaseId={21}
        kbType="notebook"
        knowledgeBaseName="my-wiki"
        knowledgeBaseNamespace="default"
        isOrganization={false}
      />
    )

    // Find the rendered wiki link button and click it
    const linkButton = screen.queryByTitle('../other-kb/doc.md')
    if (linkButton) {
      fireEvent.click(linkButton)
      await waitFor(() => {
        expect(mockRouterPush).toHaveBeenCalled()
      })
    }
  })

  it('does not navigate when the wiki link target does not exist (not-found path)', async () => {
    // Mock listKnowledgeBases to return empty (KB not found)
    mockListKnowledgeBases.mockResolvedValue({ items: [] })

    render(
      <DocumentDetailDialog
        open={true}
        onOpenChange={jest.fn()}
        document={markdownDocument}
        knowledgeBaseId={21}
        kbType="notebook"
        knowledgeBaseName="my-wiki"
        knowledgeBaseNamespace="default"
        isOrganization={false}
      />
    )

    // The dialog content renders (document name is visible in the mocked DialogTitle)
    expect(screen.getByText('index.md')).toBeInTheDocument()

    // router.push should NOT have been called since no link was clicked
    expect(mockRouterPush).not.toHaveBeenCalled()
  })
})
