// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { groupComposerContexts } from '@/features/tasks/components/input/InputBadgeDisplay'
import type { ContextItem } from '@/types/context'

describe('groupComposerContexts', () => {
  it('groups external documents by knowledge base', () => {
    const contexts: ContextItem[] = ['doc-1', 'doc-2'].map(id => ({
      type: 'external_knowledge',
      id: `external:demo-provider:explicit:kb-1:document:${id}`,
      name: id,
      ref: {
        provider: 'demo-provider',
        mode: 'explicit',
        id: 'kb-1',
        name: 'Demo Knowledge Base',
        target_type: 'document',
        node_id: id,
      },
    }))

    const groups = groupComposerContexts(contexts)

    expect(groups).toHaveLength(1)
    expect(groups[0].context).toEqual(
      expect.objectContaining({
        name: 'Demo Knowledge Base',
        selected_document_count: 2,
      })
    )
    expect(groups[0].contextIds).toHaveLength(2)
  })

  it('groups DingTalk folders and documents by container', () => {
    const contexts: ContextItem[] = [
      {
        type: 'dingtalk_doc',
        id: 'wikispace:folder-1',
        name: 'Folder',
        node_type: 'folder',
        doc_url: '',
        dingtalk_node_id: 'folder-1',
        source: 'wikispace',
        container_id: 'space-1',
        container_name: 'DingTalk Space',
      },
      {
        type: 'dingtalk_doc',
        id: 'wikispace:doc-1',
        name: 'Document',
        node_type: 'doc',
        doc_url: 'https://alidocs.dingtalk.com/i/nodes/doc-1',
        dingtalk_node_id: 'doc-1',
        source: 'wikispace',
        container_id: 'space-1',
        container_name: 'DingTalk Space',
      },
    ]

    const groups = groupComposerContexts(contexts)

    expect(groups).toHaveLength(1)
    expect(groups[0].context).toEqual(
      expect.objectContaining({
        name: 'DingTalk Space',
        selected_folder_count: 1,
        selected_document_count: 1,
      })
    )
  })
})
