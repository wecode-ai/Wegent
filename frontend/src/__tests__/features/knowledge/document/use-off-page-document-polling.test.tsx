// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { useOffPageDocumentPolling } from '@/features/knowledge/document/hooks/useOffPageDocumentPolling'
import type { KnowledgeDocument } from '@/types/knowledge'

function createDocument(overrides?: Partial<KnowledgeDocument>): KnowledgeDocument {
  return {
    id: 10,
    kind_id: 1,
    user_id: 1,
    name: 'off-page.pdf',
    file_extension: 'pdf',
    file_size: 128,
    status: 'disabled',
    is_active: false,
    index_status: 'indexing',
    index_generation: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    folder_id: 0,
    source_type: 'file',
    source_config: {},
    attachment_id: null,
    ...overrides,
  }
}

describe('useOffPageDocumentPolling', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('polls an active off-page document and stops at a terminal state', async () => {
    const active = createDocument()
    const failed = createDocument({ index_status: 'failed' })
    const fetchDocument = jest.fn().mockResolvedValue(failed)
    const onUpdate = jest.fn()
    const { rerender } = renderHook(
      ({ document }) =>
        useOffPageDocumentPolling({
          document,
          visibleDocuments: [],
          onUpdate,
          intervalMs: 1000,
          fetchDocument,
        }),
      { initialProps: { document: active } }
    )

    await act(async () => Promise.resolve())
    expect(fetchDocument).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith(failed)

    rerender({ document: failed })
    act(() => jest.advanceTimersByTime(3000))
    expect(fetchDocument).toHaveBeenCalledTimes(1)
  })

  it('recovers on the next interval after a request failure', async () => {
    const active = createDocument()
    const updated = createDocument({ index_status: 'converting' })
    const fetchDocument = jest
      .fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(updated)
    const onUpdate = jest.fn()

    renderHook(() =>
      useOffPageDocumentPolling({
        document: active,
        visibleDocuments: [],
        onUpdate,
        intervalMs: 1000,
        fetchDocument,
      })
    )
    await act(async () => Promise.resolve())
    await act(async () => {
      jest.advanceTimersByTime(1000)
      await Promise.resolve()
    })

    expect(fetchDocument).toHaveBeenCalledTimes(2)
    expect(onUpdate).toHaveBeenCalledWith(updated)
  })

  it('aborts the in-flight request when unmounted', () => {
    let signal: AbortSignal | undefined
    const fetchDocument = jest.fn((_id: number, requestSignal?: AbortSignal) => {
      signal = requestSignal
      return new Promise<KnowledgeDocument>(() => undefined)
    })
    const { unmount } = renderHook(() =>
      useOffPageDocumentPolling({
        document: createDocument(),
        visibleDocuments: [],
        onUpdate: jest.fn(),
        fetchDocument,
      })
    )

    expect(signal?.aborted).toBe(false)
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})
