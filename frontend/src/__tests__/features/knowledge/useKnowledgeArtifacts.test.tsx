// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'
import { knowledgeArtifactApi } from '@/apis/knowledge-artifacts'
import { useKnowledgeArtifacts } from '@/features/knowledge/artifact/hooks/useKnowledgeArtifacts'
import type { KnowledgeArtifact } from '@/types/knowledge-artifact'

jest.mock('@/apis/knowledge-artifacts', () => ({
  knowledgeArtifactApi: {
    list: jest.fn(),
    create: jest.fn(),
    rename: jest.fn(),
    retry: jest.fn(),
    delete: jest.fn(),
  },
}))

function buildArtifact(
  knowledgeBaseId: number,
  status: KnowledgeArtifact['status']
): KnowledgeArtifact {
  return {
    schema_version: 1,
    version: 1,
    attempt: 1,
    artifact_id: `artifact-${knowledgeBaseId}`,
    knowledge_base_id: knowledgeBaseId,
    artifact_type: 'briefing',
    title: '项目简报',
    status,
    task_id: 31,
    assistant_subtask_id: 41,
    content: status === 'succeeded' ? '# 结论' : null,
    source_document_ids: [101],
    generation_config: {},
    error_code: null,
    error_message: null,
    execution_health: 'healthy',
    can_retry: status === 'failed',
    can_delete: status !== 'queued' && status !== 'running',
    user_id: 7,
    created_at: '2026-07-26T12:00:00+08:00',
    updated_at: '2026-07-26T12:00:00+08:00',
    completed_at: status === 'succeeded' ? '2026-07-26T12:01:00+08:00' : null,
  }
}

describe('useKnowledgeArtifacts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('clears the previous knowledge base artifacts immediately when switching', async () => {
    const pending = new Promise<{
      items: KnowledgeArtifact[]
      can_manage: boolean
      available_document_count: number
      processing_document_count: number
    }>(() => undefined)
    ;(knowledgeArtifactApi.list as jest.Mock)
      .mockResolvedValueOnce({
        items: [buildArtifact(12, 'succeeded')],
        can_manage: true,
        available_document_count: 3,
        processing_document_count: 0,
      })
      .mockReturnValueOnce(pending)

    const { result, rerender } = renderHook(
      ({ knowledgeBaseId }) => useKnowledgeArtifacts(knowledgeBaseId),
      { initialProps: { knowledgeBaseId: 12 } }
    )
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    rerender({ knowledgeBaseId: 13 })

    expect(result.current.items).toEqual([])
    expect(result.current.canManage).toBe(false)
  })

  it('ignores an older response after switching knowledge bases', async () => {
    let resolveOldRequest:
      | ((response: {
          items: KnowledgeArtifact[]
          can_manage: boolean
          available_document_count: number
          processing_document_count: number
        }) => void)
      | undefined
    const oldRequest = new Promise<{
      items: KnowledgeArtifact[]
      can_manage: boolean
      available_document_count: number
      processing_document_count: number
    }>(resolve => {
      resolveOldRequest = resolve
    })
    ;(knowledgeArtifactApi.list as jest.Mock)
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce({
        items: [buildArtifact(13, 'succeeded')],
        can_manage: false,
        available_document_count: 2,
        processing_document_count: 0,
      })

    const { result, rerender } = renderHook(
      ({ knowledgeBaseId }) => useKnowledgeArtifacts(knowledgeBaseId),
      { initialProps: { knowledgeBaseId: 12 } }
    )

    rerender({ knowledgeBaseId: 13 })
    await waitFor(() => expect(result.current.items[0]?.knowledge_base_id).toBe(13))

    await act(async () => {
      resolveOldRequest?.({
        items: [buildArtifact(12, 'succeeded')],
        can_manage: true,
        available_document_count: 9,
        processing_document_count: 0,
      })
      await oldRequest
    })

    expect(result.current.items[0]?.knowledge_base_id).toBe(13)
    expect(result.current.availableDocumentCount).toBe(2)
    expect(result.current.canManage).toBe(false)
  })

  it('polls active artifacts and stops after reaching a terminal status', async () => {
    jest.useFakeTimers()
    ;(knowledgeArtifactApi.list as jest.Mock)
      .mockResolvedValueOnce({
        items: [buildArtifact(12, 'running')],
        can_manage: true,
        available_document_count: 3,
        processing_document_count: 0,
      })
      .mockResolvedValueOnce({
        items: [buildArtifact(12, 'succeeded')],
        can_manage: true,
        available_document_count: 3,
        processing_document_count: 0,
      })

    const { result } = renderHook(() => useKnowledgeArtifacts(12))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.items[0]?.status).toBe('running')

    await act(async () => {
      jest.advanceTimersByTime(5000)
      await Promise.resolve()
    })

    expect(result.current.items[0]?.status).toBe('succeeded')
    expect(knowledgeArtifactApi.list).toHaveBeenCalledTimes(2)
  })

  it('polls while documents are processing even without active artifacts', async () => {
    jest.useFakeTimers()
    ;(knowledgeArtifactApi.list as jest.Mock)
      .mockResolvedValueOnce({
        items: [],
        can_manage: false,
        available_document_count: 0,
        processing_document_count: 1,
      })
      .mockResolvedValueOnce({
        items: [],
        can_manage: false,
        available_document_count: 1,
        processing_document_count: 0,
      })

    const { result } = renderHook(() => useKnowledgeArtifacts(12))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.processingDocumentCount).toBe(1)

    await act(async () => {
      jest.advanceTimersByTime(5000)
      await Promise.resolve()
    })

    expect(result.current.availableDocumentCount).toBe(1)
    expect(result.current.processingDocumentCount).toBe(0)
    expect(knowledgeArtifactApi.list).toHaveBeenCalledTimes(2)
  })
})
