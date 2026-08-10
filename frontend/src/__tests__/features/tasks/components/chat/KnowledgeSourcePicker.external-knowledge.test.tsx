// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { countSelectedExternalKnowledgeBaseIds } from '@/features/tasks/components/chat/KnowledgeSourcePicker'
import type { ContextItem, ExternalKnowledgeRef } from '@/types/context'

jest.mock('@/apis/knowledge', () => ({
  getFolderTree: jest.fn(),
  listDocuments: jest.fn(),
}))

function externalContext(ref: ExternalKnowledgeRef): ContextItem {
  return {
    type: 'external_knowledge',
    id: `external:${ref.provider}:${ref.id}:${ref.node_id ?? 'kb'}`,
    name: ref.name ?? ref.id ?? ref.provider,
    ref,
  }
}

describe('countSelectedExternalKnowledgeBaseIds', () => {
  it('counts document refs by unique explicit knowledge base id per provider', () => {
    const contexts = [
      externalContext({
        provider: 'demo-source',
        mode: 'explicit',
        id: 'kb-1',
        target_type: 'document',
        node_id: 'document:1',
      }),
      externalContext({
        provider: 'demo-source',
        mode: 'explicit',
        id: 'kb-1',
        target_type: 'document',
        node_id: 'document:2',
      }),
      externalContext({
        provider: 'demo-source',
        mode: 'explicit',
        id: 'kb-2',
      }),
      externalContext({
        provider: 'other-source',
        mode: 'explicit',
        id: 'kb-3',
      }),
    ]

    expect(countSelectedExternalKnowledgeBaseIds(contexts, 'demo-source')).toBe(2)
  })

  it('applies removals and additions before counting', () => {
    const contexts = [
      externalContext({ provider: 'demo-source', mode: 'explicit', id: 'kb-1' }),
      externalContext({ provider: 'demo-source', mode: 'explicit', id: 'kb-2' }),
    ]
    const refsToAdd = [
      { provider: 'demo-source', mode: 'explicit', id: 'kb-2' },
      { provider: 'demo-source', mode: 'explicit', id: 'kb-3' },
    ] satisfies ExternalKnowledgeRef[]

    expect(
      countSelectedExternalKnowledgeBaseIds(contexts, 'demo-source', [contexts[0].id], refsToAdd)
    ).toBe(2)
  })
})
