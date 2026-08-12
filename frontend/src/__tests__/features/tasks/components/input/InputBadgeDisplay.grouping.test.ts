// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { groupInputContexts } from '@/features/tasks/components/input/InputBadgeDisplay'
import { buildDingTalkDocContext } from '@/features/tasks/components/chat/DingTalkDocContextSelector'
import type { ContextItem } from '@/types/context'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

const t = (key: string, params?: Record<string, unknown>) =>
  params?.folderCount !== undefined
    ? `${key}:${String(params.folderCount)}:${String(params.documentCount)}`
    : `${key}:${String(params?.count ?? '')}`

describe('groupInputContexts', () => {
  it('groups DingTalk knowledge selections by workspace identity', () => {
    const unscopedWikiNode = (id: string, name: string): DingtalkDocNode => ({
      id: Number(id.replace(/\D/g, '')),
      dingtalk_node_id: id,
      name,
      doc_url: `https://example.com/${id}`,
      parent_node_id: '',
      node_type: 'doc',
      workspace_id: '',
      content_type: 'ALIDOC',
      source: 'wikispace',
      is_active: true,
      content_updated_at: '',
      last_synced_at: '',
      created_at: '',
      updated_at: '',
      children: [],
    })
    const contexts: ContextItem[] = [
      {
        id: 'docs:doc-1',
        name: 'Doc 1',
        type: 'dingtalk_doc',
        doc_url: 'https://example.com/doc-1',
        node_type: 'doc',
        dingtalk_node_id: 'doc-1',
        source: 'docs',
      },
      {
        id: 'docs:doc-2',
        name: 'Doc 2',
        type: 'dingtalk_doc',
        doc_url: 'https://example.com/doc-2',
        node_type: 'doc',
        dingtalk_node_id: 'doc-2',
        source: 'docs',
      },
      {
        id: 'docs:folder-1',
        name: 'Folder 1',
        type: 'dingtalk_doc',
        doc_url: 'https://example.com/folder-1',
        node_type: 'folder',
        dingtalk_node_id: 'folder-1',
        source: 'docs',
      },
      {
        id: 'wikispace:doc-3',
        name: 'Doc 3',
        type: 'dingtalk_doc',
        doc_url: 'https://example.com/doc-3',
        node_type: 'doc',
        dingtalk_node_id: 'doc-3',
        source: 'wikispace',
        workspace_id: 'space-1',
        workspace_name: '产品知识库',
      },
      {
        id: 'wikispace:doc-4',
        name: 'Doc 4',
        type: 'dingtalk_doc',
        doc_url: 'https://example.com/doc-4',
        node_type: 'doc',
        dingtalk_node_id: 'doc-4',
        source: 'wikispace',
        workspace_id: 'space-2',
        workspace_name: '研发知识库',
      },
      buildDingTalkDocContext(unscopedWikiNode('doc-5', 'Unscoped 5')),
      buildDingTalkDocContext(unscopedWikiNode('doc-6', 'Unscoped 6')),
    ]

    expect(groupInputContexts(contexts, t)).toEqual([
      expect.objectContaining({
        key: 'dingtalk:docs',
        contextIds: ['docs:doc-1', 'docs:doc-2', 'docs:folder-1'],
        displayName: 'chat:dingtalkDocs.myDocsTab:',
        displaySubtitle: 'knowledge:picker.scopeMixedCompact:1:2',
      }),
      expect.objectContaining({
        key: 'dingtalk:wikispace:space-1',
        contextIds: ['wikispace:doc-3'],
        displayName: '产品知识库',
        displaySubtitle: 'knowledge:picker.scopeDocumentsCompact:1',
      }),
      expect.objectContaining({
        key: 'dingtalk:wikispace:space-2',
        contextIds: ['wikispace:doc-4'],
        displayName: '研发知识库',
        displaySubtitle: 'knowledge:picker.scopeDocumentsCompact:1',
      }),
      expect.objectContaining({
        key: 'dingtalk:wikispace:context:wikispace:doc-5',
        contextIds: ['wikispace:doc-5'],
        displayName: 'chat:dingtalkDocs.wikispaceTab:',
        displaySubtitle: 'knowledge:picker.scopeDocumentsCompact:1',
      }),
      expect.objectContaining({
        key: 'dingtalk:wikispace:context:wikispace:doc-6',
        contextIds: ['wikispace:doc-6'],
        displayName: 'chat:dingtalkDocs.wikispaceTab:',
        displaySubtitle: 'knowledge:picker.scopeDocumentsCompact:1',
      }),
    ])
  })

  it('groups external documents by provider and knowledge base without merging whole-KB refs', () => {
    const contexts: ContextItem[] = [
      {
        id: 'external:ap:kb-1:doc-1',
        name: 'Doc 1',
        type: 'external_knowledge',
        ref: {
          provider: 'ap',
          mode: 'explicit',
          id: 'kb-1',
          name: 'Project KB',
          target_type: 'document',
          node_id: 'doc-1',
        },
      },
      {
        id: 'external:ap:kb-1:doc-2',
        name: 'Doc 2',
        type: 'external_knowledge',
        ref: {
          provider: 'ap',
          mode: 'explicit',
          id: 'kb-1',
          name: 'Project KB',
          target_type: 'document',
          node_id: 'doc-2',
        },
      },
      {
        id: 'external:ap:kb-2',
        name: 'Whole KB',
        type: 'external_knowledge',
        ref: { provider: 'ap', mode: 'explicit', id: 'kb-2', name: 'Whole KB' },
      },
      {
        id: 'external:ap:all-accessible:kb-1:doc-3',
        name: 'Doc 3',
        type: 'external_knowledge',
        ref: {
          provider: 'ap',
          mode: 'all_accessible',
          id: 'kb-1',
          name: 'Project KB',
          target_type: 'document',
          node_id: 'doc-3',
        },
      },
    ]

    expect(groupInputContexts(contexts, t)).toEqual([
      expect.objectContaining({
        key: 'external:ap:explicit:kb-1',
        contextIds: ['external:ap:kb-1:doc-1', 'external:ap:kb-1:doc-2'],
        displayName: 'Project KB',
        displaySubtitle: 'knowledge:picker.scopeDocumentsCompact:2',
      }),
      expect.objectContaining({
        key: 'context:external_knowledge:external:ap:kb-2',
        contextIds: ['external:ap:kb-2'],
      }),
      expect.objectContaining({
        key: 'external:ap:all_accessible:kb-1',
        contextIds: ['external:ap:all-accessible:kb-1:doc-3'],
        displayName: 'Project KB',
        displaySubtitle: 'knowledge:picker.scopeDocumentsCompact:1',
      }),
    ])
  })
})
