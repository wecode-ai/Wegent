// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import { DocumentPanel } from '@/features/knowledge/document/components/DocumentPanel'
import type { KnowledgeBase } from '@/types/knowledge'

const mockDocumentDetailDialog = jest.fn((_props: unknown) => null)

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactPanel', () => ({
  ArtifactPanel: () => null,
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactSourceDialog', () => ({
  ArtifactSourceDialog: () => null,
}))

jest.mock('@/features/knowledge/artifact/components/ArtifactSourceSelector', () => ({
  ArtifactSourceSelector: () => null,
}))

jest.mock('@/features/knowledge/document/components/DocumentDetailDialog', () => ({
  DocumentDetailDialog: (props: unknown) => mockDocumentDetailDialog(props),
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
  })

  it('forwards organization routing context to document preview', () => {
    render(<DocumentPanel knowledgeBase={knowledgeBase} isOrganization />)

    expect(mockDocumentDetailDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isOrganization: true,
        knowledgeBaseName: 'organization-kb',
        knowledgeBaseNamespace: 'organization-name',
      })
    )
  })
})
