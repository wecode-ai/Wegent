// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  listAllExternalKnowledgeBases,
  listAllExternalNodes,
} from '@/features/knowledge/externalKnowledgePagination'
import type { ExternalKbNode, ExternalKnowledgeBase } from '@/types/external-knowledge'

function makeKnowledgeBase(index: number): ExternalKnowledgeBase {
  return {
    provider: 'fake',
    knowledge_base_id: `kb-${index}`,
    knowledge_base_name: `Knowledge Base ${index}`,
  }
}

function makeNode(index: number): ExternalKbNode {
  return {
    node_id: `doc-${index}`,
    name: `Document ${index}`,
    node_type: 'document',
  }
}

describe('external knowledge pagination helpers', () => {
  it('pages through all external knowledge bases', async () => {
    const source = {
      listKnowledgeBases: jest.fn(params =>
        Promise.resolve({
          items:
            params?.offset === 0
              ? Array.from({ length: 100 }, (_, index) => makeKnowledgeBase(index))
              : [makeKnowledgeBase(100)],
          has_more: params?.offset === 0,
        })
      ),
    }

    await expect(
      listAllExternalKnowledgeBases(source, { scope: 'organization', query: 'policy' })
    ).resolves.toHaveLength(101)
    expect(source.listKnowledgeBases).toHaveBeenNthCalledWith(1, {
      scope: 'organization',
      query: 'policy',
      limit: 100,
      offset: 0,
    })
    expect(source.listKnowledgeBases).toHaveBeenNthCalledWith(2, {
      scope: 'organization',
      query: 'policy',
      limit: 100,
      offset: 100,
    })
  })

  it('pages through all external nodes recursively by default', async () => {
    const source = {
      listNodes: jest.fn((_knowledgeBaseId: string, params) =>
        Promise.resolve({
          items:
            params?.offset === 0
              ? Array.from({ length: 500 }, (_, index) => makeNode(index))
              : [makeNode(500)],
          has_more: params?.offset === 0,
        })
      ),
    }

    await expect(listAllExternalNodes(source, 'kb-1')).resolves.toHaveLength(501)
    expect(source.listNodes).toHaveBeenNthCalledWith(1, 'kb-1', {
      recursive: true,
      limit: 500,
      offset: 0,
    })
    expect(source.listNodes).toHaveBeenNthCalledWith(2, 'kb-1', {
      recursive: true,
      limit: 500,
      offset: 500,
    })
  })

  it('fails when an external page advertises more results without returning items', async () => {
    const source = {
      listKnowledgeBases: jest.fn(() =>
        Promise.resolve({
          items: [],
          has_more: true,
        })
      ),
    }

    await expect(listAllExternalKnowledgeBases(source)).rejects.toThrow(
      'External knowledge pagination returned no items while more are available'
    )
  })
})
