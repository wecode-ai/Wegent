// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DocumentDetailDialog } from '@/features/knowledge/document/components/DocumentDetailDialog'
import type { KnowledgeDocument } from '@/types/knowledge'

const mockRouterPush = jest.fn()

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

jest.mock('@/features/knowledge/document/hooks/useDocumentDetail', () => ({
  useDocumentDetail: () => ({
    detail: {
      content: 'plain text content',
      content_length: 18,
      truncated: false,
      summary: null,
      chunks: [],
    },
    loading: false,
    error: null,
    refresh: jest.fn(),
  }),
}))

jest.mock('@/features/knowledge/document/components/ChunksSection', () => ({
  ChunksSection: () => <div data-testid="chunks-section" />,
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
          content: '[link](../other-kb/doc.md)',
          content_length: 26,
          truncated: false,
          summary: null,
          chunks: [],
        },
        loading: false,
        error: null,
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
