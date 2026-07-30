// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArtifactSourceDialog } from '@/features/knowledge/artifact/components/ArtifactSourceDialog'
import { useDocuments } from '@/features/knowledge/document/hooks/useDocuments'
import type { KnowledgeDocument } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) =>
      params?.count === undefined ? key : `${key}:${params.count}`,
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useDocuments', () => ({
  useDocuments: jest.fn(),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

describe('ArtifactSourceDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useDocuments as jest.Mock).mockReturnValue({
      documents: [
        createDocument(11),
        createDocument(12, { index_status: 'indexing' }),
        createDocument(13, { is_active: false }),
      ],
      loading: false,
      error: null,
      page: 1,
      pageSize: 100,
      totalCount: 3,
      totalPages: 1,
      goToPage: jest.fn(),
      changePageSize: jest.fn(),
      refresh: jest.fn(),
    })
  })

  it('uses the whole knowledge base without requiring select all', () => {
    const onApply = jest.fn()
    render(
      <ArtifactSourceDialog
        knowledgeBaseId={12}
        open={true}
        selectedDocumentIds={[]}
        availableDocumentCount={1}
        onOpenChange={jest.fn()}
        onApply={onApply}
      />
    )

    expect(screen.getByText('artifact.sourceDialog.allHint:1')).toBeInTheDocument()
    expect(useDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialPageSize: 20,
        serverPaginationOnly: true,
      })
    )
    fireEvent.click(screen.getByTestId('artifact-source-apply'))
    expect(onApply).toHaveBeenCalledWith([])
  })

  it('only allows indexed active documents in an explicit source set', () => {
    const onApply = jest.fn()
    render(
      <ArtifactSourceDialog
        knowledgeBaseId={12}
        open={true}
        selectedDocumentIds={[]}
        availableDocumentCount={1}
        onOpenChange={jest.fn()}
        onApply={onApply}
      />
    )

    fireEvent.click(screen.getByTestId('artifact-source-selected'))
    expect(screen.getByTestId('artifact-source-document-12')).toBeDisabled()
    expect(screen.getByTestId('artifact-source-document-13')).toBeDisabled()
    fireEvent.click(screen.getByTestId('artifact-source-document-11'))
    fireEvent.click(screen.getByTestId('artifact-source-apply'))

    expect(onApply).toHaveBeenCalledWith([11])
  })
})
