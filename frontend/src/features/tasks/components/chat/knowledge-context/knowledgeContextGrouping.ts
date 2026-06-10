// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeBase } from '@/types/api'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import { getKnowledgeBaseGroup } from '@/utils/knowledge-base-grouping'

export type KnowledgeScopeKey = 'bound' | 'personal' | `group:${string}` | 'organization'

export interface KnowledgeScopeItem {
  key: KnowledgeScopeKey
  type: 'bound' | 'personal' | 'group' | 'organization'
  label: string
  count: number
  namespace?: string
}

export interface KnowledgeOption {
  id: number
  name: string
  description?: string | null
  namespace: string
  documentCount: number
  retrievalConfig?: KnowledgeBase['retrieval_config']
  scopeKey: KnowledgeScopeKey
  scopeLabel: string
  pathLabel: string
  searchText: string
  source: 'knowledge_base' | 'bound'
}

interface BuildKnowledgeContextGroupsParams {
  knowledgeBases: KnowledgeBase[]
  boundKnowledgeBases: BoundKnowledgeBaseDetail[]
  excludeKnowledgeBaseId?: number
  organizationNamespace?: string | null
  labels: {
    bound: string
    personal: string
    groupSection: string
    organization: string
    createdByMe: string
    groupFallback: string
  }
}

function buildSearchText(parts: Array<string | number | null | undefined>): string {
  return parts.filter(Boolean).join(' ').toLowerCase()
}

function compareByName(a: KnowledgeOption, b: KnowledgeOption): number {
  const namespaceCompare = a.namespace.localeCompare(b.namespace)
  if (namespaceCompare !== 0) return namespaceCompare
  return a.name.localeCompare(b.name)
}

function toBoundOption(kb: BoundKnowledgeBaseDetail, scopeLabel: string): KnowledgeOption {
  return {
    id: kb.id,
    name: kb.display_name || kb.name,
    description: kb.description,
    namespace: kb.namespace,
    documentCount: kb.document_count || 0,
    scopeKey: 'bound',
    scopeLabel,
    pathLabel: scopeLabel,
    searchText: buildSearchText([kb.id, kb.name, kb.display_name, kb.description, kb.namespace]),
    source: 'bound',
  }
}

function toKnowledgeOption(
  kb: KnowledgeBase,
  scopeKey: KnowledgeScopeKey,
  scopeLabel: string,
  pathLabel: string
): KnowledgeOption {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    namespace: kb.namespace,
    documentCount: kb.document_count || 0,
    retrievalConfig: kb.retrieval_config,
    scopeKey,
    scopeLabel,
    pathLabel,
    searchText: buildSearchText([kb.id, kb.name, kb.description, kb.namespace, pathLabel]),
    source: 'knowledge_base',
  }
}

export function buildKnowledgeContextGroups({
  knowledgeBases,
  boundKnowledgeBases,
  excludeKnowledgeBaseId,
  organizationNamespace,
  labels,
}: BuildKnowledgeContextGroupsParams): {
  scopes: KnowledgeScopeItem[]
  optionsByScope: Map<KnowledgeScopeKey, KnowledgeOption[]>
  options: KnowledgeOption[]
} {
  const optionsByScope = new Map<KnowledgeScopeKey, KnowledgeOption[]>()
  const boundIds = new Set(boundKnowledgeBases.map(kb => kb.id))

  const appendOption = (option: KnowledgeOption) => {
    const existing = optionsByScope.get(option.scopeKey) || []
    existing.push(option)
    optionsByScope.set(option.scopeKey, existing)
  }

  for (const kb of boundKnowledgeBases) {
    if (excludeKnowledgeBaseId !== undefined && kb.id === excludeKnowledgeBaseId) continue
    appendOption(toBoundOption(kb, labels.bound))
  }

  for (const kb of knowledgeBases) {
    if (boundIds.has(kb.id)) continue
    if (excludeKnowledgeBaseId !== undefined && kb.id === excludeKnowledgeBaseId) continue

    const group = getKnowledgeBaseGroup(kb.namespace, organizationNamespace)
    if (group === 'personal') {
      appendOption(
        toKnowledgeOption(
          kb,
          'personal',
          labels.personal,
          `${labels.personal} / ${labels.createdByMe}`
        )
      )
      continue
    }

    if (group === 'organization') {
      appendOption(toKnowledgeOption(kb, 'organization', labels.organization, labels.organization))
      continue
    }

    const groupLabel = kb.namespace || labels.groupFallback
    appendOption(
      toKnowledgeOption(
        kb,
        `group:${kb.namespace}`,
        groupLabel,
        `${labels.groupSection} / ${groupLabel}`
      )
    )
  }

  for (const [scopeKey, scopeOptions] of optionsByScope) {
    optionsByScope.set(scopeKey, scopeOptions.slice().sort(compareByName))
  }

  const scopes: KnowledgeScopeItem[] = []

  const boundOptions = optionsByScope.get('bound')
  if (boundOptions?.length) {
    scopes.push({
      key: 'bound',
      type: 'bound',
      label: labels.bound,
      count: boundOptions.length,
    })
  }

  const personalOptions = optionsByScope.get('personal')
  scopes.push({
    key: 'personal',
    type: 'personal',
    label: labels.personal,
    count: personalOptions?.length || 0,
  })

  const groupScopes = Array.from(optionsByScope.entries())
    .filter(([key]) => key.startsWith('group:'))
    .map(([key, scopeOptions]) => ({
      key: key as KnowledgeScopeKey,
      type: 'group' as const,
      namespace: key.slice('group:'.length),
      label: key.slice('group:'.length) || labels.groupFallback,
      count: scopeOptions.length,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  scopes.push(...groupScopes)

  const organizationOptions = optionsByScope.get('organization')
  scopes.push({
    key: 'organization',
    type: 'organization',
    label: labels.organization,
    count: organizationOptions?.length || 0,
  })

  const options = Array.from(optionsByScope.values()).flat()

  return {
    scopes,
    optionsByScope,
    options,
  }
}
