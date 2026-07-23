// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  ContextItem,
  ExternalKnowledgeContext,
  ExternalKnowledgeRef,
  KnowledgeBaseContext,
} from '@/types/context'

export interface KnowledgeSelectionGroup {
  key: string
  sourceKind: 'internal' | 'external'
  provider?: string
  sourceId: string
  sourceName: string
  scope?: string
  selectionMode: 'all' | 'partial'
  selectedTargetCount: number
  selectedTargetNames: string[]
  refs: ContextItem[]
}

export function buildExternalGroupKey(ref: ExternalKnowledgeRef): string {
  return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}`
}

export function groupExternalRefs(refs: ExternalKnowledgeRef[]): KnowledgeSelectionGroup[] {
  const contexts: ExternalKnowledgeContext[] = refs.map(ref => ({
    type: 'external_knowledge',
    id: `${buildExternalGroupKey(ref)}:${ref.target_type ?? 'knowledge_base'}:${
      ref.node_id ?? ref.document_id ?? ''
    }`,
    name: ref.target_name || ref.name || ref.id || ref.provider,
    ref,
  }))
  return groupContextItems(contexts)
}

export function groupContextItems(contexts: ContextItem[]): KnowledgeSelectionGroup[] {
  const groups = new Map<string, KnowledgeSelectionGroup>()

  for (const context of contexts) {
    if (context.type === 'knowledge_base') {
      addInternalContext(groups, context)
      continue
    }
    if (context.type === 'external_knowledge') {
      addExternalContext(groups, context)
      continue
    }
    groups.set(`${context.type}:${context.id}`, {
      key: `${context.type}:${context.id}`,
      sourceKind: 'internal',
      sourceId: String(context.id),
      sourceName: context.name,
      selectionMode: 'all',
      selectedTargetCount: 1,
      selectedTargetNames: [context.name],
      refs: [context],
    })
  }

  return Array.from(groups.values())
}

export function removeGroup(contexts: ContextItem[], groupKey: string): ContextItem[] {
  const ids = new Set(
    groupContextItems(contexts)
      .find(group => group.key === groupKey)
      ?.refs.map(context => context.id) ?? []
  )
  if (ids.size === 0) return contexts
  return contexts.filter(context => !ids.has(context.id))
}

function addInternalContext(
  groups: Map<string, KnowledgeSelectionGroup>,
  context: KnowledgeBaseContext
) {
  const key = `internal:${context.id}`
  const documentNames = context.document_names ?? []
  const folderNames = context.folder_names ?? []
  const selectedTargetNames = [...folderNames, ...documentNames]
  const selectedTargetCount =
    (context.folder_ids?.length ?? 0) + (context.document_ids?.length ?? documentNames.length)
  groups.set(key, {
    key,
    sourceKind: 'internal',
    sourceId: String(context.id),
    sourceName: context.name,
    selectionMode: context.scope_restricted ? 'partial' : 'all',
    selectedTargetCount,
    selectedTargetNames,
    refs: [context],
  })
}

function addExternalContext(
  groups: Map<string, KnowledgeSelectionGroup>,
  context: ExternalKnowledgeContext
) {
  const ref = context.ref
  const key = buildExternalGroupKey(ref)
  const existing = groups.get(key)
  const targetName = ref.target_name || context.name
  if (existing) {
    existing.refs.push(context)
    if (targetName) existing.selectedTargetNames.push(targetName)
    existing.selectedTargetCount = countSelectedTargets(existing)
    existing.selectionMode = isWholeExternalRef(ref) ? 'all' : existing.selectionMode
    return
  }

  groups.set(key, {
    key,
    sourceKind: 'external',
    provider: ref.provider,
    sourceId: ref.id ?? 'all',
    sourceName: ref.name || ref.id || ref.provider,
    scope: ref.scope,
    selectionMode: isWholeExternalRef(ref) ? 'all' : 'partial',
    selectedTargetCount: isWholeExternalRef(ref) ? 0 : 1,
    selectedTargetNames: targetName ? [targetName] : [],
    refs: [context],
  })
}

function isWholeExternalRef(ref: ExternalKnowledgeRef): boolean {
  return !ref.target_type || ref.target_type === 'knowledge_base'
}

function countSelectedTargets(group: KnowledgeSelectionGroup): number {
  if (
    group.refs.some(
      context => context.type === 'external_knowledge' && isWholeExternalRef(context.ref)
    )
  ) {
    return 0
  }
  return group.refs.length
}
