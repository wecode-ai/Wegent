// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DingTalkDocContext, ExternalKnowledgeRef } from '@/types/context'

function externalKnowledgeScopeKey(ref: ExternalKnowledgeRef): string {
  return `${ref.provider}:${ref.mode}:${ref.scope ?? ''}:${ref.id}`
}

function externalKnowledgeTargetKey(ref: ExternalKnowledgeRef): string {
  return [
    externalKnowledgeScopeKey(ref),
    ref.target_type ?? 'knowledge_base',
    ref.node_id ?? ref.document_id ?? 'source',
  ].join(':')
}

export function normalizeSelectedExternalKnowledgeRefs(
  refs: ExternalKnowledgeRef[]
): ExternalKnowledgeRef[] {
  const wholeKnowledgeBaseScopes = new Set(
    refs
      .filter(ref => !ref.target_type || ref.target_type === 'knowledge_base')
      .map(externalKnowledgeScopeKey)
  )
  const seen = new Set<string>()

  return refs.filter(ref => {
    if (
      ref.target_type &&
      ref.target_type !== 'knowledge_base' &&
      wholeKnowledgeBaseScopes.has(externalKnowledgeScopeKey(ref))
    ) {
      return false
    }

    const targetKey = externalKnowledgeTargetKey(ref)
    if (seen.has(targetKey)) return false
    seen.add(targetKey)
    return true
  })
}

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
