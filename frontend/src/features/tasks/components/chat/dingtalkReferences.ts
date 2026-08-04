// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { formatCompactKnowledgeScope } from '@/features/knowledge/knowledgeContextPresentation'
import { groupDingTalkContexts } from '@/features/knowledge/dingTalkContextGrouping'
import type { DingTalkDocContext } from '@/types/context'

type Translate = (key: string, params?: Record<string, unknown>) => string

function escapeMarkdownLabel(label: string) {
  return label.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

export function formatDingTalkReferences(contexts: DingTalkDocContext[], t: Translate): string {
  return groupDingTalkContexts(contexts, t)
    .map(group => {
      const folderCount = group.contexts.filter(context => context.node_type === 'folder').length
      const documentCount = group.contexts.length - folderCount
      const scopeLabel = formatCompactKnowledgeScope(folderCount, documentCount, t)
      const references = group.contexts
        .map(context => `  - [${escapeMarkdownLabel(context.name)}](${context.doc_url})`)
        .join('\n')
      return `- **${group.displayName} · ${scopeLabel}**\n${references}`
    })
    .join('\n')
}
