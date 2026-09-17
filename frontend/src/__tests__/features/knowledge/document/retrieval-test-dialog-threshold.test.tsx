// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { apiClient } from '@/apis/client'
import { retrieverApis } from '@/apis/retrievers'
import { RetrievalTestDialog } from '@/features/knowledge/document/components/RetrievalTestDialog'
import { DEFAULT_SCORE_THRESHOLD } from '@/features/knowledge/document/components/retrievalConfig'
import type { KnowledgeBase } from '@/types/knowledge'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/apis/client', () => ({
  apiClient: { post: jest.fn() },
}))

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBase: jest.fn(),
}))

jest.mock('@/apis/retrievers', () => ({
  retrieverApis: {
    getRetriever: jest.fn(),
    getStorageTypeRetrievalMethods: jest.fn(),
  },
}))

function makeKnowledgeBase(scoreThreshold?: number): KnowledgeBase {
  return {
    id: 123,
    name: 'retrieval-test-kb',
    description: null,
    user_id: 1,
    namespace: 'default',
    direct_access_requirement: 'read',
    kb_type: 'classic',
    document_count: 3,
    is_active: true,
    summary_enabled: false,
    max_calls_per_conversation: 10,
    exempt_calls_before_check: 5,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
    retrieval_config: {
      retriever_name: 'retriever-a',
      retriever_namespace: 'default',
      embedding_config: { model_name: 'embed-a', model_namespace: 'default' },
      retrieval_mode: 'vector',
      top_k: 5,
      ...(scoreThreshold === undefined ? {} : { score_threshold: scoreThreshold }),
    },
  }
}

async function searchWithThreshold(knowledgeBase: KnowledgeBase) {
  ;(apiClient.post as jest.Mock).mockResolvedValue({ records: [] })
  ;(retrieverApis.getRetriever as jest.Mock).mockResolvedValue({
    spec: { storageConfig: { type: 'milvus' } },
  })
  ;(retrieverApis.getStorageTypeRetrievalMethods as jest.Mock).mockResolvedValue({
    retrieval_methods: ['vector'],
  })

  render(<RetrievalTestDialog open onOpenChange={jest.fn()} knowledgeBase={knowledgeBase} />)

  const queryInput = await screen.findByRole('textbox')
  await waitFor(() => expect(queryInput).toBeEnabled())
  fireEvent.change(queryInput, { target: { value: 'release checklist' } })

  fireEvent.click(screen.getByRole('button', { name: 'knowledge:document.retrievalTest.search' }))

  await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1))
  return (apiClient.post as jest.Mock).mock.calls[0][1] as Record<string, unknown>
}

describe('RetrievalTestDialog threshold prefill', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('sends the same "do not cut" default as the real retrieval path', async () => {
    const request = await searchWithThreshold(makeKnowledgeBase())

    expect(request.score_threshold).toBe(DEFAULT_SCORE_THRESHOLD)
  })

  it('keeps a threshold the knowledge base configures explicitly', async () => {
    const request = await searchWithThreshold(makeKnowledgeBase(0.7))

    expect(request.score_threshold).toBe(0.7)
  })
})
