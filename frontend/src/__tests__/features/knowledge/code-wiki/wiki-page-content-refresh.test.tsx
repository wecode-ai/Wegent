// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import { WikiPageContent } from '@/features/knowledge/code-wiki/WikiPageContent'
import { readDocumentText } from '@/apis/knowledge'
import type { CodeWikiPageNode } from '@/types/code-wiki'

jest.mock('@/apis/knowledge', () => ({ readDocumentText: jest.fn() }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/features/theme/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light' }),
}))
jest.mock(
  'next/dynamic',
  () => () =>
    function Markdown({ source }: { source: string }) {
      return <div>{source}</div>
    }
)

const PAGE: CodeWikiPageNode = {
  path: 'index',
  title: 'Overview',
  document_id: 11,
  has_content: true,
  children: [],
}

describe('refreshing a published wiki page', () => {
  beforeEach(() => jest.mocked(readDocumentText).mockReset())

  it('reloads content when a new generation preserves the document id', async () => {
    jest
      .mocked(readDocumentText)
      .mockResolvedValueOnce('old body')
      .mockResolvedValueOnce('new body')

    const props = {
      page: PAGE,
      onContentChange: jest.fn(),
      knownPaths: new Set(['index']),
      onNavigate: jest.fn(),
    }
    const view = render(<WikiPageContent {...props} publishedGenerationId={33} />)
    await waitFor(() => expect(screen.getByText('old body')).toBeInTheDocument())

    view.rerender(<WikiPageContent {...props} publishedGenerationId={34} />)

    await waitFor(() => expect(screen.getByText('new body')).toBeInTheDocument())
    expect(readDocumentText).toHaveBeenCalledTimes(2)
    expect(readDocumentText).toHaveBeenNthCalledWith(2, 11)
  })
})
