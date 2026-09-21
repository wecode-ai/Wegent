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

const syncedWikiDocument: KnowledgeDocument = {
  id: 42,
  kind_id: 1,
  user_id: 1,
  name: '远程 Wiki 页面',
  file_extension: 'md',
  file_size: 15,
  status: 'enabled',
  is_active: true,
  index_status: 'success',
  index_generation: 0,
  created_at: '2026-09-04T00:00:00Z',
  updated_at: '2026-09-04T00:00:00Z',
  folder_id: 0,
  source_type: 'external',
  source_config: {
    external: {
      provider: 'wiki',
      title: 'Synchronized Wiki',
      url: 'https://wiki.example.com/operations/handbook',
      sync: {
        enabled: true,
        observed_version: '2026-09-03T12:34:56Z',
        last_synced_at: '2026-09-03T18:30:00Z',
      },
    },
  },
  attachment_id: 430,
  created_by: 'alice',
}

describe('DocumentItem external wiki actions', () => {
  it('shows reindex for synchronized wiki documents only after indexing fails', () => {
    const { rerender } = render(
      <DocumentItem
        document={syncedWikiDocument}
        onSync={jest.fn()}
        onReindex={jest.fn()}
        ragConfigured
      />
    )

    expect(screen.getByTestId('sync-document-42')).toBeInTheDocument()
    expect(screen.queryByTestId('reindex-document-42')).not.toBeInTheDocument()

    rerender(
      <DocumentItem
        document={{ ...syncedWikiDocument, index_status: 'failed' }}
        onSync={jest.fn()}
        onReindex={jest.fn()}
        ragConfigured
      />
    )

    expect(screen.getByTestId('sync-document-42')).toBeInTheDocument()
    expect(screen.getByTestId('reindex-document-42')).toBeInTheDocument()
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

    const failedStatus = screen.getByTestId('document-processing-error-42')
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

    expect(screen.getByTestId('document-wiki-status-42')).toHaveTextContent(
      'knowledge:document.document.indexStatus.available'
    )
    const sourceStatus = screen.getByTestId('external-source-inaccessible')
    await user.hover(sourceStatus)
    // The shared badge resolves its copy from the knowledge namespace.
    expect(await screen.findByText('document.document.wikiSourceMissing')).toBeInTheDocument()
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

  it('shows a synchronization error while keeping the existing index available', async () => {
    const user = userEvent.setup()
    render(
      <DocumentItem
        document={{
          ...syncedWikiDocument,
          source_config: {
            external: {
              provider: 'wiki',
              title: 'Synchronized Wiki',
              status: 'sync_error',
              last_error: '无法连接 Wiki 站点',
              sync: { enabled: true, last_error_code: 'wiki_connection_failed' },
            },
          },
        }}
      />
    )

    expect(screen.getByTestId('document-wiki-status-42')).toHaveTextContent(
      'knowledge:document.document.indexStatus.available'
    )
    const sourceStatus = screen.getByTestId('external-source-inaccessible')
    expect(sourceStatus).toHaveTextContent('document.document.sourceSyncFailed')
    await user.hover(sourceStatus)
    expect((await screen.findAllByText('无法连接 Wiki 站点')).length).toBeGreaterThan(0)
  })
})

describe('DocumentItem external wiki metadata display', () => {
  // Dates render in the viewer's local timezone; compute expectations the
  // same way so the test is timezone-independent.
  const formatLocal = (iso: string) =>
    new Date(iso).toLocaleString('sv-SE', { hour12: false }).replace(/-/g, '/')

  it.each([true, false])('shows MD with a Wiki icon when compact=%s', compact => {
    render(<DocumentItem document={syncedWikiDocument} compact={compact} />)
    const type = screen.getByTestId('synced-wiki-document-type')
    expect(type).toHaveTextContent('MD')
    expect(type.querySelector('svg')).toHaveClass('lucide-book-open')
  })

  it('shows the latest successful index time in compact mode', () => {
    render(<DocumentItem document={syncedWikiDocument} compact />)
    const expectedDate = formatLocal('2026-09-03T18:30:00Z').split(' ')[0]
    expect(screen.getByText(expectedDate)).toBeInTheDocument()
  })

  it('shows the latest successful index time in table mode', () => {
    render(<DocumentItem document={syncedWikiDocument} />)
    expect(screen.getByTestId('updated-at-cell')).toHaveTextContent(
      formatLocal('2026-09-03T18:30:00Z')
    )
  })

  it('shows the real markdown size instead of a placeholder (table)', () => {
    render(<DocumentItem document={syncedWikiDocument} />)
    expect(screen.getByText('15 B')).toBeInTheDocument()
  })

  it('shows the real markdown size in compact mode too', () => {
    render(<DocumentItem document={syncedWikiDocument} compact />)
    expect(screen.getByText('15 B')).toBeInTheDocument()
  })

  it('shows no update time when the successful index time is invalid', () => {
    const document: KnowledgeDocument = {
      ...syncedWikiDocument,
      source_config: {
        external: {
          provider: 'wiki',
          sync: {
            enabled: true,
            observed_version: '2026-09-03T12:34:56Z',
            last_synced_at: 'not-a-date',
          },
        },
      },
    }
    render(<DocumentItem document={document} />)
    expect(screen.getByTestId('updated-at-cell')).toHaveTextContent('-')
  })
})
