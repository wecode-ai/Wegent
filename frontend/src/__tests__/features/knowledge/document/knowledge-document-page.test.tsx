// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import { KnowledgeDocumentPage } from '@/features/knowledge/document/components/KnowledgeDocumentPage'

let mockIsMobile = true

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => mockIsMobile,
}))

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('group=source:external-provider'),
}))

jest.mock('@/features/knowledge/knowledgeSourceViewRegistry', () => ({
  useKnowledgeSourceViews: () => [
    {
      id: 'external-provider',
      label: 'External Source',
      renderView: () => <div data-testid="external-source-view" />,
    },
  ],
}))

jest.mock('@/features/knowledge/document/components/KnowledgeDocumentPageMobile', () => ({
  KnowledgeDocumentPageMobile: () => <div data-testid="knowledge-document-page-mobile" />,
}))

jest.mock('@/features/knowledge/document/components/KnowledgeDocumentPageDesktop', () => ({
  KnowledgeDocumentPageDesktop: () => <div data-testid="knowledge-document-page-desktop" />,
}))

describe('KnowledgeDocumentPage responsive routing', () => {
  beforeEach(() => {
    mockIsMobile = true
  })

  it('renders the mobile knowledge page instead of an external source view for source URL params', () => {
    render(<KnowledgeDocumentPage />)

    expect(screen.getByTestId('knowledge-document-page-mobile')).toBeInTheDocument()
    expect(screen.queryByTestId('external-source-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-document-page-desktop')).not.toBeInTheDocument()
  })
})
