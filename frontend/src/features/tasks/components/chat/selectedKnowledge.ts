// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DingTalkDocContext, ExternalKnowledgeRef } from '@/types/context'

export function buildDingTalkKnowledgeRef(context: DingTalkDocContext): ExternalKnowledgeRef {
  const isWorkspaceRoot =
    context.source === 'wikispace' &&
    Boolean(context.workspace_id) &&
    context.dingtalk_node_id === context.workspace_id
  const targetType = isWorkspaceRoot
    ? 'knowledge_base'
    : context.node_type === 'folder'
      ? 'folder'
      : 'document'
  const knowledgeBaseId =
    context.source === 'wikispace'
      ? context.workspace_id || context.dingtalk_node_id
      : 'dingtalk-docs'

  return {
    provider: 'dingtalk',
    mode: 'explicit',
    id: knowledgeBaseId,
    name: context.workspace_name || (context.source === 'docs' ? '钉钉文档' : context.name),
    scope: context.source,
    target_type: targetType,
    node_id: targetType === 'knowledge_base' ? undefined : context.dingtalk_node_id,
    document_id: targetType === 'document' ? context.dingtalk_node_id : undefined,
    target_name: targetType === 'knowledge_base' ? undefined : context.name,
    resource_url: context.doc_url,
  }
}
