// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DingTalkDocContext } from '@/types/context'

type Translate = (key: string, params?: Record<string, unknown>) => string

export interface DingTalkContextGroup {
  key: string
  displayName: string
  contexts: DingTalkDocContext[]
}

function getDingTalkContextGroupKey(context: DingTalkDocContext): string {
  if (context.source === 'docs') {
    return 'dingtalk:docs'
  }
  return `dingtalk:wikispace:${context.workspace_id ?? 'unknown'}`
}

function getDingTalkContextGroupName(context: DingTalkDocContext, t: Translate): string {
  if (context.source === 'docs') {
    return t('chat:dingtalkDocs.myDocsTab')
  }
  return context.workspace_name ?? t('chat:dingtalkDocs.wikispaceTab')
}

export function groupDingTalkContexts(
  contexts: DingTalkDocContext[],
  t: Translate
): DingTalkContextGroup[] {
  const groups: DingTalkContextGroup[] = []
  const groupIndexes = new Map<string, number>()

  contexts.forEach(context => {
    const key = getDingTalkContextGroupKey(context)
    const existingIndex = groupIndexes.get(key)
    if (existingIndex === undefined) {
      groupIndexes.set(key, groups.length)
      groups.push({
        key,
        displayName: getDingTalkContextGroupName(context, t),
        contexts: [context],
      })
      return
    }
    groups[existingIndex].contexts.push(context)
  })

  return groups
}
