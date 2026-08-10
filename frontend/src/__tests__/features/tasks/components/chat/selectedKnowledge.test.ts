// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { buildDingTalkKnowledgeRef } from '@/features/tasks/components/chat/selectedKnowledge'
import type { DingTalkDocContext } from '@/types/context'

function context(overrides: Partial<DingTalkDocContext>): DingTalkDocContext {
  return {
    type: 'dingtalk_doc',
    id: 'dingtalk:test',
    name: '测试节点',
    doc_url: 'https://alidocs.dingtalk.com/i/nodes/node-1',
    dingtalk_node_id: 'node-1',
    node_type: 'doc',
    source: 'wikispace',
    ...overrides,
  }
}

describe('buildDingTalkKnowledgeRef', () => {
  it('maps a knowledge-space root to knowledge-base scope', () => {
    const ref = buildDingTalkKnowledgeRef(
      context({
        dingtalk_node_id: 'workspace-1',
        workspace_id: 'workspace-1',
        workspace_name: '项目空间',
      })
    )

    expect(ref).toMatchObject({
      provider: 'dingtalk',
      id: 'workspace-1',
      target_type: 'knowledge_base',
    })
    expect(ref.node_id).toBeUndefined()
  })

  it('preserves a folder node as folder scope', () => {
    const ref = buildDingTalkKnowledgeRef(
      context({
        name: '评审资料',
        node_type: 'folder',
        dingtalk_node_id: 'folder-1',
        workspace_id: 'workspace-1',
      })
    )

    expect(ref).toMatchObject({
      id: 'workspace-1',
      target_type: 'folder',
      node_id: 'folder-1',
      target_name: '评审资料',
    })
  })

  it('maps a personal document to the provider document collection', () => {
    const ref = buildDingTalkKnowledgeRef(
      context({
        source: 'docs',
        dingtalk_node_id: 'doc-1',
        doc_url: 'https://alidocs.dingtalk.com/i/nodes/doc-1',
      })
    )

    expect(ref).toMatchObject({
      id: 'dingtalk-docs',
      target_type: 'document',
      node_id: 'doc-1',
      document_id: 'doc-1',
      resource_url: 'https://alidocs.dingtalk.com/i/nodes/doc-1',
    })
  })
})
