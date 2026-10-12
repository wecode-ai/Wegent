// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { useExternalDocumentSync } from '@/features/knowledge/document/hooks/useExternalDocumentSync'
import type { KnowledgeDocument } from '@/types/knowledge'

const mockSynchronizeExternalDocument = jest.fn()

jest.mock('@/apis/knowledge', () => ({
  synchronizeExternalDocument: (...args: unknown[]) => mockSynchronizeExternalDocument(...args),
}))

jest.mock('@/hooks/use-toast', () => ({
  toast: jest.fn(),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

function createDocument(overrides?: Partial<KnowledgeDocument>): KnowledgeDocument {
  return {
    id: 41,
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
        status: 'accessible',
      },
    },
    ...overrides,
  } as KnowledgeDocument
}

/**
 * The two surfaces that expose the manual sync entry, each holding its own
 * hook instance the way the list and the document preview do.
 */
function TwoSurfaces({ document }: { document: KnowledgeDocument }) {
  const list = useExternalDocumentSync()
  const preview = useExternalDocumentSync()
  return (
    <div>
      <button
        data-testid="list-sync"
        disabled={list.isSyncing(document.id)}
        onClick={() => void list.syncDocument(document)}
      >
        list
      </button>
      <button
        data-testid="preview-sync"
        disabled={preview.isSyncing(document.id)}
        onClick={() => void preview.syncDocument(document)}
      >
        preview
      </button>
    </div>
  )
}

describe('useExternalDocumentSync', () => {
  beforeEach(() => {
    mockSynchronizeExternalDocument.mockReset()
  })

  it('shares the in-flight guard across hook instances', async () => {
    let finishSync: (() => void) | undefined
    mockSynchronizeExternalDocument.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishSync = resolve
        })
    )

    render(<TwoSurfaces document={createDocument()} />)

    fireEvent.click(screen.getByTestId('list-sync'))
    await waitFor(() => expect(mockSynchronizeExternalDocument).toHaveBeenCalledTimes(1))

    // The other surface reports the same copy as busy and queues nothing.
    expect(screen.getByTestId('preview-sync')).toBeDisabled()
    fireEvent.click(screen.getByTestId('preview-sync'))
    expect(mockSynchronizeExternalDocument).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishSync?.()
    })
    await waitFor(() => expect(screen.getByTestId('preview-sync')).not.toBeDisabled())
  })

  it('releases the shared guard after a failed request', async () => {
    mockSynchronizeExternalDocument.mockRejectedValue(new Error('无法连接钉钉'))

    render(<TwoSurfaces document={createDocument()} />)

    fireEvent.click(screen.getByTestId('list-sync'))
    await waitFor(() => expect(screen.getByTestId('preview-sync')).not.toBeDisabled())

    fireEvent.click(screen.getByTestId('preview-sync'))
    await waitFor(() => expect(mockSynchronizeExternalDocument).toHaveBeenCalledTimes(2))
  })
})
