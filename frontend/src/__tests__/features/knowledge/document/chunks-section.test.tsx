// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import { ChunksSection } from '@/features/knowledge/document/components/ChunksSection'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'document.document.detail.chunksTitle': 'Chunks',
        'document.document.detail.splitterType': 'Splitter Type',
        'document.document.detail.chunkTokens': '1 tokens',
        'document.document.detail.chunksEmpty': 'No chunks',
        'document.document.detail.chunksLoading': 'Loading chunks',
        'document.document.detail.chunksError': 'Failed to load chunks',
        'document.document.detail.copySuccess': 'Copied',
        'document.document.detail.copyError': 'Copy failed',
      }

      return translations[key] ?? key
    },
  }),
}))

jest.mock('@/features/knowledge/document/hooks/useDocumentChunks', () => ({
  useDocumentChunks: jest.fn(() => ({
    chunks: [
      {
        index: 0,
        content: '## Intro\nHello world',
        token_count: 12,
        start_position: 0,
        end_position: 20,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 10,
    splitterType: 'flat',
    splitterSubtype: 'markdown_sentence',
    loading: false,
    error: null,
    hasMore: false,
    loadMore: jest.fn(),
    refresh: jest.fn(),
  })),
}))

describe('ChunksSection', () => {
  it('shows normalized splitter subtype when chunk metadata is file-aware', () => {
    render(<ChunksSection documentId={11} enabled={true} />)

    fireEvent.click(screen.getByRole('button', { name: /Chunks/i }))

    expect(screen.getByText('flat (markdown_sentence)')).toBeInTheDocument()
  })
})
