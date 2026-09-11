// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DocumentItem } from '@/features/knowledge/document/components/DocumentItem'
import type { KnowledgeDocument } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/knowledge/multimodal/hooks/useMultimodalDocActions', () => ({
  useMultimodalDocActions: () => ({
    canReanalyze: false,
    handleReanalyze: jest.fn(),
  }),
}))

const wikiDocument: KnowledgeDocument = {
  id: 42,
  kind_id: 1,
  user_id: 1,
  name: '远程 Wiki 页面',
  file_extension: 'md',
  file_size: 0,
  status: 'enabled',
  is_active: true,
  index_status: 'not_indexed',
  index_generation: 0,
  created_at: '2026-09-04T00:00:00Z',
  updated_at: '2026-09-04T00:00:00Z',
  folder_id: 0,
  source_type: 'external_wiki',
  source_config: {
    wiki: {
      path: 'operations/handbook',
      resource_url: 'https://wiki.example.com/operations/handbook',
    },
  },
  attachment_id: null,
  created_by: 'alice',
}

// A legacy row created before the metadata backfill: created_at equals
// updated_at (the bind instant) but the wiki page time survives in the
// nested source_config. The list must still show the source page time.
const legacyWikiDocument: KnowledgeDocument = {
  ...wikiDocument,
  source_config: {
    wiki: {
      path: 'operations/handbook',
      resource_url: 'https://wiki.example.com/operations/handbook',
      page_updated_at: '2026-09-03T12:34:56Z',
    },
  },
}

// A row bound after the fix: file_size is the real Markdown byte length
// and updated_at carries the wiki page time.
const backfilledWikiDocument: KnowledgeDocument = {
  ...wikiDocument,
  file_size: 15,
  updated_at: '2026-09-03T12:34:56Z',
  source_config: {
    wiki: {
      path: 'operations/handbook',
      resource_url: 'https://wiki.example.com/operations/handbook',
      page_updated_at: '2026-09-03T12:34:56Z',
    },
  },
}

const syncedWikiDocument: KnowledgeDocument = {
  ...backfilledWikiDocument,
  id: 43,
  source_type: 'external',
  index_status: 'success',
  attachment_id: 430,
  source_config: {
    external: {
      provider: 'wiki',
      title: 'Synchronized Wiki',
      sync: { enabled: true },
    },
  },
}

describe('DocumentItem external wiki actions', () => {
  it('does not offer local edit or indexing actions for a live remote page', async () => {
    const user = userEvent.setup()
    render(
      <DocumentItem
        document={wikiDocument}
        compact
        onEdit={jest.fn()}
        onMove={jest.fn()}
        onDelete={jest.fn()}
        onReindex={jest.fn()}
      />
    )

    await user.click(screen.getByTestId('document-actions-42'))

    expect(screen.queryByText('common:actions.edit')).not.toBeInTheDocument()
    expect(screen.queryByTestId('reindex-document-42')).not.toBeInTheDocument()
    expect(await screen.findByText('knowledge:document.folder.moveDocument')).toBeInTheDocument()
  })

  it('shows reindex for synchronized wiki documents only after indexing fails', () => {
    const { rerender } = render(
      <DocumentItem
        document={syncedWikiDocument}
        onSync={jest.fn()}
        onReindex={jest.fn()}
        ragConfigured
      />
    )

    expect(screen.getByTestId('sync-document-43')).toBeInTheDocument()
    expect(screen.queryByTestId('reindex-document-43')).not.toBeInTheDocument()

    rerender(
      <DocumentItem
        document={{ ...syncedWikiDocument, index_status: 'failed' }}
        onSync={jest.fn()}
        onReindex={jest.fn()}
        ragConfigured
      />
    )

    expect(screen.getByTestId('sync-document-43')).toBeInTheDocument()
    expect(screen.getByTestId('reindex-document-43')).toBeInTheDocument()
  })

  it('shows the backend failure reason when a synchronized wiki document fails', async () => {
    const user = userEvent.setup()
    render(
      <DocumentItem
        document={{
          ...syncedWikiDocument,
          index_status: 'failed',
          processing_error: {
            stage: 'system',
            code: 'external_import_failed',
            message: '无法连接 Wiki 站点',
            retryable: true,
            generation: 1,
            occurred_at: '2026-09-07T10:22:05Z',
            provider: 'wiki',
          },
        }}
      />
    )

    const failedStatus = screen.getByTestId('document-processing-error-43')
    expect(failedStatus).toHaveTextContent('knowledge:document.document.indexStatus.failed')
    await user.hover(failedStatus)
    expect((await screen.findAllByText('无法连接 Wiki 站点')).length).toBeGreaterThan(0)
  })

  it('shows a missing wiki source while keeping the existing index available', async () => {
    const user = userEvent.setup()
    render(
      <DocumentItem
        document={{
          ...syncedWikiDocument,
          source_config: {
            external: {
              provider: 'wiki',
              title: 'Synchronized Wiki',
              status: 'inaccessible',
              sync: {
                enabled: true,
                last_error_code: 'external_source_missing',
              },
            },
          },
        }}
      />
    )

    expect(screen.getByTestId('document-wiki-status-43')).toHaveTextContent(
      'knowledge:document.document.indexStatus.available'
    )
    const sourceStatus = screen.getByTestId('external-source-inaccessible')
    await user.hover(sourceStatus)
    expect(
      await screen.findByText('knowledge:document.document.wikiSourceMissing')
    ).toBeInTheDocument()
  })

  it('shows the missing wiki source in compact mode', () => {
    render(
      <DocumentItem
        compact
        document={{
          ...syncedWikiDocument,
          source_config: {
            external: {
              provider: 'wiki',
              title: 'Synchronized Wiki',
              status: 'inaccessible',
              sync: {
                enabled: true,
                last_error_code: 'external_source_missing',
              },
            },
          },
        }}
      />
    )

    expect(screen.getByTestId('external-source-inaccessible-compact')).toHaveTextContent(
      'knowledge:document.document.wikiSourceMissing'
    )
  })
})

describe('DocumentItem external wiki metadata display', () => {
  // Dates render in the viewer's local timezone; compute expectations the
  // same way so the test is timezone-independent.
  const formatLocal = (iso: string) =>
    new Date(iso).toLocaleString('sv-SE', { hour12: false }).replace(/-/g, '/')

  it('shows the source page time for a legacy row awaiting backfill (compact)', () => {
    render(<DocumentItem document={legacyWikiDocument} compact />)
    // Compact mode shows date only; the legacy row's created_at (09-04)
    // must not win over the source page date (09-03).
    expect(screen.getByText('2026/09/03')).toBeInTheDocument()
  })

  it('shows the source page time for a legacy row awaiting backfill (table)', () => {
    render(<DocumentItem document={legacyWikiDocument} />)
    expect(screen.getByTestId('updated-at-cell')).toHaveTextContent(
      formatLocal('2026-09-03T12:34:56Z')
    )
  })

  it('shows the real markdown size instead of a placeholder (table)', () => {
    render(<DocumentItem document={backfilledWikiDocument} />)
    expect(screen.getByText('15 B')).toBeInTheDocument()
  })

  it('shows the real markdown size in compact mode too', () => {
    render(<DocumentItem document={backfilledWikiDocument} compact />)
    expect(screen.getByText('15 B')).toBeInTheDocument()
  })

  it('shows the source page time for a backfilled row (table)', () => {
    render(<DocumentItem document={backfilledWikiDocument} />)
    expect(screen.getByTestId('updated-at-cell')).toHaveTextContent(
      formatLocal('2026-09-03T12:34:56Z')
    )
  })

  it('does not render an invalid page_updated_at', () => {
    const document: KnowledgeDocument = {
      ...legacyWikiDocument,
      source_config: {
        wiki: {
          path: 'operations/handbook',
          page_updated_at: 'not-a-date',
        },
      },
    }
    render(<DocumentItem document={document} />)
    expect(screen.getByTestId('updated-at-cell')).not.toHaveTextContent('Invalid Date')
  })
})
