// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArtifactSourceSelector } from '@/features/knowledge/artifact/components/ArtifactSourceSelector'
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

const document = (id: number, overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument => ({
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
    ;(useDocuments as jest.Mock).mockReturnValue({
      documents: [document(11), document(12, { index_status: 'indexing' })],
      loading: false,
      error: null,
      page: 1,
      pageSize: 100,
      totalCount: 2,
      totalPages: 1,
      goToPage: jest.fn(),
      changePageSize: jest.fn(),
    })
  })

  it('browses documents and selects only available sources from the inline view', () => {
    const onModeChange = jest.fn()
    const onSelectedDocumentIdsChange = jest.fn()
    const onOpenDocument = jest.fn()

    render(
      <ArtifactSourceSelector
        knowledgeBaseId={12}
        mode="all"
        selectedDocumentIds={new Set()}
        availableDocumentCount={1}
        compact
        onModeChange={onModeChange}
        onSelectedDocumentIdsChange={onSelectedDocumentIdsChange}
        onOpenDocument={onOpenDocument}
      />
    )

    expect(screen.getByText('artifact.sourceBrowser.documents')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('artifact-source-open-document-11'))
    expect(onOpenDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }))

    fireEvent.click(screen.getByTestId('artifact-source-document-11'))
    expect(onModeChange).toHaveBeenCalledWith('selected')
    expect(onSelectedDocumentIdsChange).toHaveBeenCalledWith(new Set([11]))
    expect(screen.getByTestId('artifact-source-document-12')).toBeDisabled()
  })
})
