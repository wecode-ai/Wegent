// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

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

// The action menu is the list's real entry point; render its items inline so
// the assertions read the menu the user opens instead of a portal.
jest.mock('@/components/ui/dropdown', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
    ...rest
  }: {
    children: ReactNode
    disabled?: boolean
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
    'data-testid'?: string
  }) => (
    <button type="button" disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function createDocument(overrides?: Partial<KnowledgeDocument>): KnowledgeDocument {
  return {
    id: 88,
    kind_id: 1,
    user_id: 1,
    name: '钉钉文档',
    file_extension: 'md',
    file_size: 128,
    status: 'enabled',
    is_active: true,
    index_status: 'success',
    index_generation: 1,
    created_at: '2026-09-04T00:00:00Z',
    updated_at: '2026-09-04T00:00:00Z',
    folder_id: 0,
    source_type: 'external',
    source_config: {
      external: {
        provider: 'dingtalk',
        resource_id: 'node-1',
        title: '钉钉文档',
        url: 'https://alidocs.dingtalk.com/i/nodes/node-1',
        status: 'accessible',
        last_success_at: '2026-09-04T00:00:00Z',
      },
    },
    attachment_id: 880,
    created_by: 'alice',
    ...overrides,
  }
}

describe('DocumentItem DingTalk manual sync', () => {
  it('offers no manual sync for documents that are not DingTalk copies', () => {
    const { rerender } = render(
      <DocumentItem
        document={createDocument({
          source_config: {
            external: {
              provider: 'wiki',
              title: 'Synchronized Wiki',
              sync: { enabled: true },
            },
          },
        })}
        onSync={jest.fn()}
      />
    )
    expect(screen.queryByTestId('sync-dingtalk-document-88')).not.toBeInTheDocument()

    rerender(
      <DocumentItem
        document={createDocument({
          name: '普通文档',
          source_type: 'file',
          attachment_id: null,
          source_config: {},
        })}
        onSync={jest.fn()}
      />
    )
    expect(screen.queryByTestId('sync-dingtalk-document-88')).not.toBeInTheDocument()

    rerender(
      <DocumentItem
        document={createDocument({
          source_config: {
            external: { provider: 'other', title: 'Other source' },
          },
        })}
        onSync={jest.fn()}
      />
    )
    expect(screen.queryByTestId('sync-dingtalk-document-88')).not.toBeInTheDocument()
  })

  it('offers "sync now" in the action menu of a DingTalk copy', () => {
    render(<DocumentItem compact document={createDocument()} onSync={jest.fn()} />)

    expect(screen.getByTestId('sync-dingtalk-document-88')).toHaveTextContent(
      'document.document.syncNow'
    )
  })

  it('offers "retry sync" once the DingTalk source is no longer accessible', () => {
    render(
      <DocumentItem
        compact
        document={createDocument({
          source_config: {
            external: {
              provider: 'dingtalk',
              resource_id: 'node-1',
              title: '钉钉文档',
              status: 'inaccessible',
              last_error: '钉钉文档已失效',
            },
          },
        })}
        onSync={jest.fn()}
      />
    )

    expect(screen.getByTestId('sync-dingtalk-document-88')).toHaveTextContent(
      'document.document.syncRetry'
    )
  })

  it('disables the entry and reports progress while a sync is running', () => {
    const onSync = jest.fn()
    render(<DocumentItem compact document={createDocument()} onSync={onSync} isSyncing />)

    const syncItem = screen.getByTestId('sync-dingtalk-document-88')
    expect(syncItem).toBeDisabled()
    expect(syncItem).toHaveTextContent('document.document.syncing')

    fireEvent.click(syncItem)
    expect(onSync).not.toHaveBeenCalled()
  })

  it('retries a failed DingTalk copy through sync, not a second entry', () => {
    render(
      <DocumentItem
        document={createDocument({ index_status: 'failed', is_active: false })}
        onSync={jest.fn()}
        onReindex={jest.fn()}
      />
    )

    // The sync entry carries the retry: an import-retry control would queue the
    // same source refresh again under a second name.
    expect(screen.getByTestId('sync-dingtalk-document-88')).toHaveAttribute(
      'aria-label',
      'document.document.syncRetry'
    )
    expect(screen.queryByTestId('retry-import-document-88')).not.toBeInTheDocument()
  })

  it('keeps the import retry for an external copy without a sync entry', () => {
    render(
      <DocumentItem
        document={createDocument({
          index_status: 'failed',
          is_active: false,
          source_config: {
            external: { provider: 'wiki', title: 'Synchronized Wiki' },
          },
        })}
        onReindex={jest.fn()}
      />
    )

    expect(screen.getByTestId('retry-import-document-88')).toBeInTheDocument()
  })

  it('keeps the entry out of the table row when no sync handler is provided', () => {
    render(<DocumentItem document={createDocument()} />)

    expect(screen.queryByTestId('sync-dingtalk-document-88')).not.toBeInTheDocument()
  })
})
