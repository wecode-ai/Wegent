// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { formatDingTalkReferences } from '@/features/tasks/components/chat/dingtalkReferences'
import type { DingTalkDocContext } from '@/types/context'

const t = (key: string, params?: Record<string, unknown>) => {
  if (key === 'chat:dingtalkDocs.myDocsTab') return '我的文档'
  if (key === 'chat:dingtalkDocs.wikispaceTab') return '知识库'
  if (key === 'knowledge:picker.scopeMixedCompact') {
    return `${params?.folderCount} 文件夹 · ${params?.documentCount} 文档`
  }
  if (key === 'knowledge:picker.scopeDocumentsCompact') return `${params?.count} 文档`
  return key
}

function context(
  id: string,
  source: DingTalkDocContext['source'],
  nodeType: DingTalkDocContext['node_type']
): DingTalkDocContext {
  return {
    id,
    type: 'dingtalk_doc',
    name: `Node ${id}`,
    doc_url: `https://alidocs.dingtalk.com/i/nodes/${id}`,
    node_type: nodeType,
    dingtalk_node_id: id,
    source,
  }
}

describe('formatDingTalkReferences', () => {
  it('keeps docs and wikispace references in separate compact groups', () => {
    const result = formatDingTalkReferences(
      [
        context('1', 'docs', 'folder'),
        context('2', 'docs', 'doc'),
        context('3', 'wikispace', 'doc'),
      ],
      t
    )

    expect(result).toContain('**我的文档 · 1 文件夹 · 1 文档**')
    expect(result).toContain('**知识库 · 1 文档**')
    expect(result).toContain('[Node 1](https://alidocs.dingtalk.com/i/nodes/1)')
  })
})
