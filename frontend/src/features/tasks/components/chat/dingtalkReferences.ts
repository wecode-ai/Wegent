// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { formatCompactKnowledgeScope } from '@/features/knowledge/knowledgeContextPresentation'
import type { DingTalkDocContext } from '@/types/context'

type Translate = (key: string, params?: Record<string, unknown>) => string

function escapeMarkdownLabel(label: string) {
  return label.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

export function formatDingTalkReferences(contexts: DingTalkDocContext[], t: Translate): string {
  const groups: Array<{ source: DingTalkDocContext['source']; items: DingTalkDocContext[] }> = [
    { source: 'docs', items: contexts.filter(context => context.source === 'docs') },
    { source: 'wikispace', items: contexts.filter(context => context.source === 'wikispace') },
  ]

  return groups
    .filter(group => group.items.length > 0)
    .map(group => {
      const folderCount = group.items.filter(context => context.node_type === 'folder').length
      const documentCount = group.items.length - folderCount
      const sourceLabel =
        group.source === 'docs'
          ? t('chat:dingtalkDocs.myDocsTab')
          : t('chat:dingtalkDocs.wikispaceTab')
      const scopeLabel = formatCompactKnowledgeScope(folderCount, documentCount, t)
      const references = group.items
        .map(context => `  - [${escapeMarkdownLabel(context.name)}](${context.doc_url})`)
        .join('\n')
      return `- **${sourceLabel} · ${scopeLabel}**\n${references}`
    })
    .join('\n')
}
