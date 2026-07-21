// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Building2,
  Check,
  ChevronRight,
  Cloud,
  Database,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquareText,
  RotateCw,
  Users,
  User,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LongTextTooltip, TruncatedText } from '@/components/common/long-text'
import { getFolderTree, listDocuments } from '@/apis/knowledge'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import type { KnowledgeBase, KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'
import type {
  ContextItem,
  ExternalKnowledgeContext,
  ExternalKnowledgeRef,
  KnowledgeBaseContext,
} from '@/types/context'
import type {
  ExternalKnowledgeBaseDisplayDescriptor,
  ExternalKnowledgeScopeDescriptor,
  ExternalKnowledgeScopeStatus,
  ExternalKnowledgeSource,
} from '@/features/knowledge/externalKnowledgeSourceRegistry'
import {
  listAllExternalKnowledgeBases,
  listAllExternalNodes,
} from '@/features/knowledge/externalKnowledgePagination'
import type {
  ExternalKbNode,
  ExternalKnowledgeBase,
  ExternalKnowledgeScope,
} from '@/types/external-knowledge'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'

export interface GroupedKnowledgeBases {
  personal: KnowledgeBase[]
  group: Map<string, GroupedKnowledgeBaseGroup>
  organization: KnowledgeBase[]
}

export interface GroupedKnowledgeBaseGroup {
  name: string
  displayName: string
  items: KnowledgeBase[]
}

type SourceKey = 'personal' | 'group' | 'organization' | `external:${string}`

const INTERNAL_DOCUMENT_PAGE_SIZE = 200
const DEFAULT_EXTERNAL_SCOPE_ICON = 'cloud'

interface KnowledgeSourcePickerProps {
  groupedKnowledgeBases: GroupedKnowledgeBases
  boundKnowledgeBases: BoundKnowledgeBaseDetail[]
  externalSources: ExternalKnowledgeSource[]
  selectedContexts: ContextItem[]
  searchValue: string
  loading: boolean
  error: string | null
  onRetry: () => void
  onSelect: (context: ContextItem) => void
  onDeselect: (id: number | string) => void
  onReplaceContexts?: (idsToRemove: (number | string)[], contextsToAdd: ContextItem[]) => void
}

interface ActiveInternalKnowledgeBase {
  source: 'internal'
  knowledgeBase: KnowledgeBase
}

interface ActiveExternalKnowledgeBase {
  source: 'external'
  provider: ExternalKnowledgeSource
  knowledgeBase: ExternalKnowledgeBase
}

type ActiveKnowledgeBase = ActiveInternalKnowledgeBase | ActiveExternalKnowledgeBase

interface InternalTreeNode {
  id: string
  name: string
  type: 'folder' | 'document'
  folderId?: number
  document?: KnowledgeDocument
  path: string[]
  folderPathIds: number[]
  documentCount: number
  children: InternalTreeNode[]
}

interface KnowledgeContextScopeInput {
  documents?: KnowledgeDocument[]
  folderIds?: number[]
  folderNames?: string[]
  includeSubfolders?: boolean
}

function toKnowledgeContext(
  kb: KnowledgeBase,
  scope: KnowledgeContextScopeInput = {}
): KnowledgeBaseContext {
  const documentIds = scope.documents?.map(doc => doc.id) ?? []
  const folderIds = scope.folderIds ?? []
  const scopeRestricted = documentIds.length > 0 || folderIds.length > 0
  return {
    id: kb.id,
    name: kb.name,
    type: 'knowledge_base',
    description: kb.description ?? undefined,
    retriever_name: kb.retrieval_config?.retriever_name,
    retriever_namespace: kb.retrieval_config?.retriever_namespace,
    document_count: kb.document_count,
    document_ids: documentIds.length > 0 ? documentIds : undefined,
    document_names:
      scope.documents && scope.documents.length > 0
        ? scope.documents.map(doc => doc.name)
        : undefined,
    folder_ids: folderIds.length > 0 ? folderIds : undefined,
    folder_names: scope.folderNames && scope.folderNames.length > 0 ? scope.folderNames : undefined,
    include_subfolders: folderIds.length > 0 ? (scope.includeSubfolders ?? true) : undefined,
    scope_restricted: scopeRestricted,
  }
}

function buildExternalContextId(ref: ExternalKnowledgeRef) {
  const targetType = ref.target_type ?? 'knowledge_base'
  if (targetType !== 'knowledge_base') {
    const targetId = ref.node_id ?? ref.document_id ?? 'unknown'
    return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}:${targetType}:${targetId}`
  }
  return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}`
}

function supportsExternalKnowledgeBaseSelection(source: ExternalKnowledgeSource) {
  return source.capabilities?.supportsKnowledgeBaseSelection === true
}

export function countSelectedExternalKnowledgeBaseIds(
  contexts: ContextItem[],
  providerId: string,
  idsToRemove: (number | string)[] = [],
  refsToAdd: ExternalKnowledgeRef[] = []
) {
  const removedIds = new Set(idsToRemove)
  const selectedIds = new Set<string>()

  contexts.forEach(ctx => {
    if (
      ctx.type !== 'external_knowledge' ||
      removedIds.has(ctx.id) ||
      ctx.ref.provider !== providerId ||
      ctx.ref.mode !== 'explicit' ||
      !ctx.ref.id
    ) {
      return
    }
    selectedIds.add(ctx.ref.id)
  })

  refsToAdd.forEach(ref => {
    if (ref.provider === providerId && ref.mode === 'explicit' && ref.id) {
      selectedIds.add(ref.id)
    }
  })

  return selectedIds.size
}

function stripTypedExternalId(value?: string | null) {
  if (!value) return undefined
  const index = value.indexOf(':')
  return index >= 0 ? value.slice(index + 1) : value
}

function groupMatchesSearch(text: string, query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return text.toLowerCase().includes(normalized)
}

async function listAllInternalDocuments(knowledgeBaseId: number): Promise<KnowledgeDocument[]> {
  const documents: KnowledgeDocument[] = []
  let offset = 0

  while (true) {
    const response = await listDocuments(knowledgeBaseId, {
      limit: INTERNAL_DOCUMENT_PAGE_SIZE,
      offset,
    })
    documents.push(...response.items)

    if (!response.has_more) {
      return documents
    }

    if (response.items.length === 0) {
      throw new Error('Document pagination returned no items while more results are available')
    }

    offset += response.items.length
  }
}

function buildInternalTree(
  folders: KnowledgeFolder[],
  documents: KnowledgeDocument[]
): InternalTreeNode[] {
  const docsByFolder = new Map<number, KnowledgeDocument[]>()
  for (const doc of documents) {
    const folderId = doc.folder_id || 0
    const next = docsByFolder.get(folderId) ?? []
    next.push(doc)
    docsByFolder.set(folderId, next)
  }

  const consumedFolderIds = new Set<number>()

  const buildDocument = (
    doc: KnowledgeDocument,
    path: string[],
    folderPathIds: number[]
  ): InternalTreeNode => ({
    id: `document-${doc.id}`,
    name: doc.name,
    type: 'document',
    document: doc,
    path,
    folderPathIds,
    documentCount: 1,
    children: [],
  })

  const buildFolder = (
    folder: KnowledgeFolder,
    parentPath: string[],
    parentFolderPathIds: number[]
  ): InternalTreeNode => {
    const path = [...parentPath, folder.name]
    const folderPathIds = [...parentFolderPathIds, folder.id]
    const folderDocs = docsByFolder.get(folder.id) ?? []
    consumedFolderIds.add(folder.id)
    const children = [
      ...(folder.children ?? []).map(child => buildFolder(child, path, folderPathIds)),
      ...folderDocs.map(doc => buildDocument(doc, path, folderPathIds)),
    ]
    return {
      id: `folder-${folder.id}`,
      name: folder.name,
      type: 'folder',
      folderId: folder.id,
      path,
      folderPathIds,
      documentCount: children.reduce((total, child) => total + child.documentCount, 0),
      children,
    }
  }

  const folderNodes = folders.map(folder => buildFolder(folder, [], []))
  const rootDocs = docsByFolder.get(0) ?? []
  const orphanDocs = Array.from(docsByFolder.entries())
    .filter(([folderId]) => folderId !== 0 && !consumedFolderIds.has(folderId))
    .flatMap(([, folderDocs]) => folderDocs)

  return [
    ...folderNodes,
    ...rootDocs.map(doc => buildDocument(doc, [], [])),
    ...orphanDocs.map(doc => buildDocument(doc, [], [])),
  ]
}

function flattenInternalSearchResults(nodes: InternalTreeNode[]) {
  const result: Array<{ node: InternalTreeNode; path: string[] }> = []

  const walk = (node: InternalTreeNode) => {
    if (node.type === 'folder' || node.document) {
      result.push({ node, path: node.path })
    }
    node.children.forEach(walk)
  }

  nodes.forEach(walk)
  return result
}

function flattenExternalDocuments(nodes: ExternalKbNode[]) {
  const result: Array<{ node: ExternalKbNode; path: string[] }> = []

  const walk = (node: ExternalKbNode, parentPath: string[]) => {
    if (node.node_type === 'folder') {
      const nextPath = [...parentPath, node.name]
      const children = node.children ?? []
      children.forEach(child => walk(child, nextPath))
      return
    }
    result.push({ node, path: parentPath })
  }

  nodes.forEach(node => walk(node, []))
  return result
}

function countExternalDocuments(node: ExternalKbNode): number {
  if (node.node_type !== 'folder') {
    return 1
  }
  return (node.children ?? []).reduce((total, child) => total + countExternalDocuments(child), 0)
}

function getExternalKnowledgeScopes(
  source: ExternalKnowledgeSource
): ExternalKnowledgeScopeDescriptor[] {
  if (source.scopes && source.scopes.length > 0) {
    return source.scopes
  }
  return [
    {
      key: 'all',
      label: source.label ?? source.providerId,
      labelKey: source.labelKey,
      icon: DEFAULT_EXTERNAL_SCOPE_ICON,
    },
  ]
}

function getExternalScopeIcon(scope: ExternalKnowledgeScopeDescriptor) {
  return getExternalDisplayIcon(scope.icon)
}

function getExternalSourceIcon(source: ExternalKnowledgeSource) {
  return getExternalDisplayIcon(source.icon)
}

function getExternalDisplayIcon(icon?: string) {
  if (icon === 'personal') return User
  if (icon === 'organization') return Building2
  if (icon === 'file') return FileText
  if (icon === 'database') return Database
  if (icon === 'message') return MessageSquareText
  if (icon === 'folderOpen') return FolderOpen
  return Cloud
}

function getExternalScopeLabel(
  scope: ExternalKnowledgeScopeDescriptor,
  t: (key: string) => string
) {
  if (scope.labelKey) return t(scope.labelKey)
  if (scope.label) return scope.label
  return scope.key
}

function getExternalSourceLabel(source: ExternalKnowledgeSource, t: (key: string) => string) {
  if (source.labelKey) return t(source.labelKey)
  if (source.label) return source.label
  return source.providerId
}

function getExternalKnowledgeBaseDisplay(
  source: ExternalKnowledgeSource,
  knowledgeBase: ExternalKnowledgeBase
): ExternalKnowledgeBaseDisplayDescriptor {
  return source.getKnowledgeBaseDisplay?.(knowledgeBase) ?? {}
}

function getExternalScopeActionHref(
  source: ExternalKnowledgeSource,
  scopeKey: ExternalKnowledgeScope,
  action: 'configure' | 'sync'
) {
  const scope = source.scopes?.find(item => item.key === scopeKey)
  if (action === 'sync') {
    return scope?.syncHref || source.syncHref || scope?.configureHref || source.configureHref
  }
  return scope?.configureHref || source.configureHref
}

function getExternalKnowledgeBaseLabel(
  display: ExternalKnowledgeBaseDisplayDescriptor,
  knowledgeBase: ExternalKnowledgeBase,
  t: (key: string) => string
) {
  if (display.labelKey) return t(display.labelKey)
  if (display.label) return display.label
  return knowledgeBase.knowledge_base_name
}

function hasSelectedInternalDocument(node: InternalTreeNode, selectedDocIds: Set<number>): boolean {
  if (node.document) {
    return selectedDocIds.has(node.document.id)
  }
  return node.children.some(child => hasSelectedInternalDocument(child, selectedDocIds))
}

function hasSelectedInternalFolder(
  node: InternalTreeNode,
  selectedFolderIds: Set<number>
): boolean {
  if (
    node.type === 'folder' &&
    node.folderId !== undefined &&
    selectedFolderIds.has(node.folderId)
  ) {
    return true
  }
  return node.children.some(child => hasSelectedInternalFolder(child, selectedFolderIds))
}

function isCoveredBySelectedAncestorFolder(
  node: InternalTreeNode,
  selectedFolderIds: Set<number>
): boolean {
  const ancestorFolderIds =
    node.type === 'folder' ? node.folderPathIds.slice(0, -1) : node.folderPathIds
  return ancestorFolderIds.some(folderId => selectedFolderIds.has(folderId))
}

function hasSelectedExternalDocument(node: ExternalKbNode, selectedNodeIds: Set<string>): boolean {
  if (node.node_type !== 'folder') {
    return selectedNodeIds.has(node.node_id)
  }
  return (node.children ?? []).some(child => hasSelectedExternalDocument(child, selectedNodeIds))
}

function matchesPathSearch(name: string, path: string[], query: string) {
  return groupMatchesSearch([name, ...path].join(' '), query)
}

function formatKnowledgePath(path: string[], name: string) {
  return path.length > 0 ? [...path, name].join(' / ') : name
}

function getKnowledgeContext(
  selectedContexts: ContextItem[],
  knowledgeBaseId: number
): KnowledgeBaseContext | undefined {
  return selectedContexts.find(
    (ctx): ctx is KnowledgeBaseContext =>
      ctx.type === 'knowledge_base' && ctx.id === knowledgeBaseId
  )
}

function getExternalContext(
  selectedContexts: ContextItem[],
  providerId: string,
  knowledgeBaseId: string
): ExternalKnowledgeContext | undefined {
  return selectedContexts.find(
    (ctx): ctx is ExternalKnowledgeContext =>
      ctx.type === 'external_knowledge' &&
      ctx.ref.provider === providerId &&
      ctx.ref.id === knowledgeBaseId &&
      (!ctx.ref.target_type || ctx.ref.target_type === 'knowledge_base')
  )
}

function getExternalDocumentContext(
  selectedContexts: ContextItem[],
  providerId: string,
  knowledgeBaseId: string,
  nodeId: string
): ExternalKnowledgeContext | undefined {
  return selectedContexts.find(
    (ctx): ctx is ExternalKnowledgeContext =>
      ctx.type === 'external_knowledge' &&
      ctx.ref.provider === providerId &&
      ctx.ref.id === knowledgeBaseId &&
      ctx.ref.target_type === 'document' &&
      ctx.ref.node_id === nodeId
  )
}

function getExternalChildContexts(
  selectedContexts: ContextItem[],
  providerId: string,
  knowledgeBaseId: string
): ExternalKnowledgeContext[] {
  return selectedContexts.filter(
    (ctx): ctx is ExternalKnowledgeContext =>
      ctx.type === 'external_knowledge' &&
      ctx.ref.provider === providerId &&
      ctx.ref.id === knowledgeBaseId &&
      Boolean(ctx.ref.target_type) &&
      ctx.ref.target_type !== 'knowledge_base'
  )
}

export function KnowledgeSourcePicker({
  groupedKnowledgeBases,
  boundKnowledgeBases,
  externalSources,
  selectedContexts,
  searchValue,
  loading,
  error,
  onRetry,
  onSelect,
  onDeselect,
  onReplaceContexts,
}: KnowledgeSourcePickerProps) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()
  const browseableExternalSources = useMemo(
    () =>
      externalSources
        .filter(source => source.listKnowledgeBases)
        .sort((a, b) => {
          const orderA = a.displayOrder ?? Number.MAX_SAFE_INTEGER
          const orderB = b.displayOrder ?? Number.MAX_SAFE_INTEGER
          if (orderA !== orderB) return orderA - orderB
          return getExternalSourceLabel(a, t).localeCompare(getExternalSourceLabel(b, t))
        }),
    [externalSources, t]
  )
  const [activeSource, setActiveSource] = useState<SourceKey>('personal')
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [externalScope, setExternalScope] = useState<ExternalKnowledgeScope | null>(null)
  const [activeKnowledgeBase, setActiveKnowledgeBase] = useState<ActiveKnowledgeBase | null>(null)

  const externalProviderId = activeSource.startsWith('external:')
    ? activeSource.slice('external:'.length)
    : null
  const activeExternalSource = externalProviderId
    ? browseableExternalSources.find(source => source.providerId === externalProviderId)
    : undefined
  const [externalKnowledgeBaseCounts, setExternalKnowledgeBaseCounts] = useState<
    Map<string, number>
  >(new Map())

  useEffect(() => {
    const sourcesWithCount = browseableExternalSources.filter(
      source => source.getKnowledgeBaseCount
    )
    if (sourcesWithCount.length === 0) {
      setExternalKnowledgeBaseCounts(prev => (prev.size === 0 ? prev : new Map()))
      return
    }

    let cancelled = false
    sourcesWithCount.forEach(source => {
      source.getKnowledgeBaseCount!()
        .then(count => {
          if (cancelled) return
          setExternalKnowledgeBaseCounts(prev => {
            if (prev.get(source.providerId) === count) return prev
            const next = new Map(prev)
            next.set(source.providerId, count)
            return next
          })
        })
        .catch(() => {
          if (cancelled) return
          setExternalKnowledgeBaseCounts(prev => {
            if (prev.get(source.providerId) === 0) return prev
            const next = new Map(prev)
            next.set(source.providerId, 0)
            return next
          })
        })
    })

    return () => {
      cancelled = true
    }
  }, [browseableExternalSources])

  useEffect(() => {
    if (!activeExternalSource) {
      setExternalScope(null)
      return
    }
    const scopes = getExternalKnowledgeScopes(activeExternalSource)
    setExternalScope(prev => {
      if (prev && scopes.some(scope => scope.key === prev)) return prev
      return null
    })
  }, [activeExternalSource])

  const groupEntries = useMemo(
    () => Array.from(groupedKnowledgeBases.group.entries()),
    [groupedKnowledgeBases.group]
  )
  const boundKnowledgeBaseItems = useMemo<KnowledgeBase[]>(
    () =>
      boundKnowledgeBases.map(kb => ({
        id: kb.id,
        name: kb.name,
        description: kb.description ?? null,
        namespace: kb.namespace ?? 'default',
        kb_type: 'notebook',
        document_count: kb.document_count ?? 0,
        is_active: true,
        summary_enabled: false,
        max_calls_per_conversation: 0,
        exempt_calls_before_check: 0,
        created_at: kb.bound_at ?? '',
        updated_at: kb.bound_at ?? '',
        user_id: 0,
      })),
    [boundKnowledgeBases]
  )

  const sourceRows = useMemo(
    () => [
      {
        key: 'personal' as SourceKey,
        label: t('picker.sources.personal'),
        count: groupedKnowledgeBases.personal.length,
        icon: User,
      },
      {
        key: 'group' as SourceKey,
        label: t('picker.sources.group'),
        count: groupedKnowledgeBases.group.size,
        icon: Users,
      },
      {
        key: 'organization' as SourceKey,
        label: t('picker.sources.organization'),
        count: groupedKnowledgeBases.organization.length,
        icon: Building2,
      },
      ...browseableExternalSources.map(source => ({
        key: `external:${source.providerId}` as SourceKey,
        label: getExternalSourceLabel(source, t),
        count: externalKnowledgeBaseCounts.get(source.providerId) ?? 0,
        icon: getExternalSourceIcon(source),
      })),
    ],
    [
      browseableExternalSources,
      externalKnowledgeBaseCounts,
      groupedKnowledgeBases.group.size,
      groupedKnowledgeBases.organization.length,
      groupedKnowledgeBases.personal.length,
      t,
    ]
  )

  const replaceContexts = useCallback(
    (idsToRemove: (number | string)[], contextsToAdd: ContextItem[]) => {
      if (onReplaceContexts) {
        onReplaceContexts(idsToRemove, contextsToAdd)
        return
      }
      idsToRemove.forEach(id => onDeselect(id))
      contextsToAdd.forEach(context => onSelect(context))
    },
    [onDeselect, onReplaceContexts, onSelect]
  )

  const canAddExternalRefs = useCallback(
    (
      source: ExternalKnowledgeSource,
      idsToRemove: (number | string)[],
      refsToAdd: ExternalKnowledgeRef[]
    ) => {
      const maxKnowledgeBases = source.selectionLimits?.maxKnowledgeBases
      if (!maxKnowledgeBases) return true

      const nextCount = countSelectedExternalKnowledgeBaseIds(
        selectedContexts,
        source.providerId,
        idsToRemove,
        refsToAdd
      )
      if (nextCount <= maxKnowledgeBases) return true

      toast({
        title: t('picker.externalSelectionLimit', {
          source: getExternalSourceLabel(source, t),
          count: maxKnowledgeBases,
        }),
        variant: 'destructive',
      })
      return false
    },
    [selectedContexts, t, toast]
  )

  const toggleInternalKnowledgeBase = (kb: KnowledgeBase) => {
    const existing = getKnowledgeContext(selectedContexts, kb.id)
    if (existing && !existing.scope_restricted) {
      onDeselect(kb.id)
      return
    }
    replaceContexts(existing ? [existing.id] : [], [toKnowledgeContext(kb)])
  }

  const toggleInternalDocument = (kb: KnowledgeBase, doc: KnowledgeDocument) => {
    const existing = getKnowledgeContext(selectedContexts, kb.id)
    const existingIds = existing?.scope_restricted ? (existing.document_ids ?? []) : []
    const existingFolderIds = existing?.scope_restricted ? (existing.folder_ids ?? []) : []
    const existingFolderNames = existing?.scope_restricted ? (existing.folder_names ?? []) : []
    const selected = existingIds.includes(doc.id)
    const nextIds = selected ? existingIds.filter(id => id !== doc.id) : [...existingIds, doc.id]

    if (nextIds.length === 0 && existingFolderIds.length === 0) {
      if (existing) onDeselect(existing.id)
      return
    }

    const treeState = internalTreeByKb.get(kb.id)
    const documentsById = new Map((treeState?.documents ?? []).map(item => [item.id, item]))
    const nextDocuments = nextIds
      .map(id => (id === doc.id ? doc : documentsById.get(id)))
      .filter((item): item is KnowledgeDocument => Boolean(item))

    replaceContexts(existing ? [existing.id] : [], [
      toKnowledgeContext(kb, {
        documents: nextDocuments,
        folderIds: existingFolderIds,
        folderNames: existingFolderNames,
        includeSubfolders: existing?.include_subfolders ?? true,
      }),
    ])
  }

  const toggleInternalFolder = (kb: KnowledgeBase, node: InternalTreeNode) => {
    if (node.type !== 'folder' || node.folderId === undefined) {
      return
    }

    const existing = getKnowledgeContext(selectedContexts, kb.id)
    const existingFolderIds = existing?.scope_restricted ? (existing.folder_ids ?? []) : []
    const existingFolderNames = existing?.scope_restricted ? (existing.folder_names ?? []) : []
    const existingDocumentIds = existing?.scope_restricted ? (existing.document_ids ?? []) : []
    const selected = existingFolderIds.includes(node.folderId)
    const nextFolderIds = selected
      ? existingFolderIds.filter(id => id !== node.folderId)
      : [...existingFolderIds, node.folderId]
    const nextFolderNames = selected
      ? existingFolderNames.filter((_, index) => existingFolderIds[index] !== node.folderId)
      : [...existingFolderNames, node.name]

    if (nextFolderIds.length === 0 && existingDocumentIds.length === 0) {
      if (existing) onDeselect(existing.id)
      return
    }

    const treeState = internalTreeByKb.get(kb.id)
    const documentsById = new Map((treeState?.documents ?? []).map(item => [item.id, item]))
    const nextDocuments = existingDocumentIds
      .map(id => documentsById.get(id))
      .filter((item): item is KnowledgeDocument => Boolean(item))

    replaceContexts(existing ? [existing.id] : [], [
      toKnowledgeContext(kb, {
        documents: nextDocuments,
        folderIds: nextFolderIds,
        folderNames: nextFolderNames,
        includeSubfolders: true,
      }),
    ])
  }

  const toggleExternalKnowledgeBase = (
    source: ExternalKnowledgeSource,
    kb: ExternalKnowledgeBase
  ) => {
    if (!supportsExternalKnowledgeBaseSelection(source)) {
      return
    }
    const existing = getExternalContext(selectedContexts, source.providerId, kb.knowledge_base_id)
    const childContexts = getExternalChildContexts(
      selectedContexts,
      source.providerId,
      kb.knowledge_base_id
    )
    if (existing) {
      replaceContexts([existing.id, ...childContexts.map(ctx => ctx.id)], [])
      return
    }
    const ref = source.toRef
      ? source.toRef(kb)
      : {
          provider: source.providerId,
          mode: 'explicit',
          id: kb.knowledge_base_id,
          name: kb.knowledge_base_name,
          scope: kb.scope ?? undefined,
        }
    const context: ExternalKnowledgeContext = {
      type: 'external_knowledge',
      id: buildExternalContextId(ref),
      name: ref.name ?? ref.id ?? ref.provider,
      ref,
    }
    const idsToRemove = childContexts.map(ctx => ctx.id)
    if (!canAddExternalRefs(source, idsToRemove, [ref])) {
      return
    }
    replaceContexts(idsToRemove, [context])
  }

  const toggleExternalDocument = (
    source: ExternalKnowledgeSource,
    kb: ExternalKnowledgeBase,
    node: ExternalKbNode
  ) => {
    const wholeKb = getExternalContext(selectedContexts, source.providerId, kb.knowledge_base_id)
    const existing = getExternalDocumentContext(
      selectedContexts,
      source.providerId,
      kb.knowledge_base_id,
      node.node_id
    )
    if (existing) {
      onDeselect(existing.id)
      return
    }

    const ref: ExternalKnowledgeRef = {
      provider: source.providerId,
      mode: 'explicit',
      id: kb.knowledge_base_id,
      name: kb.knowledge_base_name,
      scope: kb.scope ?? undefined,
      target_type: 'document',
      node_id: node.node_id,
      document_id: stripTypedExternalId(node.raw_id ?? node.node_id),
      parent_id: stripTypedExternalId(node.parent_id),
      target_name: node.name,
    }
    const context: ExternalKnowledgeContext = {
      type: 'external_knowledge',
      id: buildExternalContextId(ref),
      name: node.name,
      ref,
    }
    if (wholeKb) {
      if (!canAddExternalRefs(source, [wholeKb.id], [ref])) {
        return
      }
      replaceContexts([wholeKb.id], [context])
      return
    }
    if (!canAddExternalRefs(source, [], [ref])) {
      return
    }
    onSelect(context)
  }

  const [internalTreeByKb, setInternalTreeByKb] = useState<
    Map<
      number,
      {
        loading: boolean
        error: string | null
        tree: InternalTreeNode[]
        documents: KnowledgeDocument[]
      }
    >
  >(new Map())
  const [externalKbByScope, setExternalKbByScope] = useState<
    Map<string, { loading: boolean; error: string | null; items: ExternalKnowledgeBase[] }>
  >(new Map())
  const externalKbQueries = useRef(new Map<string, string>())
  const [externalNodesByKb, setExternalNodesByKb] = useState<
    Map<string, { loading: boolean; error: string | null; items: ExternalKbNode[] }>
  >(new Map())
  const [externalScopeStatusesByProvider, setExternalScopeStatusesByProvider] = useState<
    Map<string, ExternalKnowledgeScopeStatus[]>
  >(new Map())
  const [syncingExternalScopes, setSyncingExternalScopes] = useState<Set<string>>(new Set())

  const loadInternalTree = useCallback(
    async (kb: KnowledgeBase) => {
      setInternalTreeByKb(prev => {
        const next = new Map(prev)
        next.set(kb.id, { loading: true, error: null, tree: [], documents: [] })
        return next
      })
      try {
        const [folders, documents] = await Promise.all([
          getFolderTree(kb.id),
          listAllInternalDocuments(kb.id),
        ])
        setInternalTreeByKb(prev => {
          const next = new Map(prev)
          next.set(kb.id, {
            loading: false,
            error: null,
            tree: buildInternalTree(folders, documents),
            documents,
          })
          return next
        })
      } catch (loadError) {
        setInternalTreeByKb(prev => {
          const next = new Map(prev)
          next.set(kb.id, {
            loading: false,
            error: loadError instanceof Error ? loadError.message : t('fetch_error'),
            tree: [],
            documents: [],
          })
          return next
        })
      }
    },
    [t]
  )

  const loadExternalKnowledgeBases = useCallback(
    async (source: ExternalKnowledgeSource, scope: ExternalKnowledgeScope, query = '') => {
      if (!source.listKnowledgeBases) return
      const cacheKey = `${source.providerId}:${scope}`
      const normalizedQuery = query.trim()
      externalKbQueries.current.set(cacheKey, normalizedQuery)
      setExternalKbByScope(prev => {
        const next = new Map(prev)
        next.set(cacheKey, { loading: true, error: null, items: [] })
        return next
      })
      try {
        const [items, statuses] = await Promise.all([
          listAllExternalKnowledgeBases(source, {
            scope,
            query: normalizedQuery || undefined,
          }),
          source.getScopeStatuses?.() ?? Promise.resolve([]),
        ])
        setExternalKbByScope(prev => {
          const next = new Map(prev)
          next.set(cacheKey, { loading: false, error: null, items })
          return next
        })
        setExternalScopeStatusesByProvider(prev => {
          const next = new Map(prev)
          next.set(source.providerId, statuses)
          return next
        })
      } catch (loadError) {
        setExternalKbByScope(prev => {
          const next = new Map(prev)
          next.set(cacheKey, {
            loading: false,
            error: loadError instanceof Error ? loadError.message : t('fetch_error'),
            items: [],
          })
          return next
        })
      }
    },
    [t]
  )

  const syncExternalScope = useCallback(
    async (source: ExternalKnowledgeSource, scope: ExternalKnowledgeScope) => {
      if (!source.syncScope) return
      const syncKey = `${source.providerId}:${scope}`
      setSyncingExternalScopes(prev => new Set(prev).add(syncKey))
      try {
        await source.syncScope(scope)
        await loadExternalKnowledgeBases(source, scope, searchValue)
      } catch (syncError) {
        setExternalKbByScope(prev => {
          const next = new Map(prev)
          next.set(syncKey, {
            loading: false,
            error:
              syncError instanceof Error ? syncError.message : t('chat:dingtalkDocs.syncFailed'),
            items: [],
          })
          return next
        })
      } finally {
        setSyncingExternalScopes(prev => {
          const next = new Set(prev)
          next.delete(syncKey)
          return next
        })
      }
    },
    [loadExternalKnowledgeBases, searchValue, t]
  )

  useEffect(() => {
    if (!activeExternalSource || !externalScope) return

    const cacheKey = `${activeExternalSource.providerId}:${externalScope}`
    const normalizedQuery = searchValue.trim()
    if (externalKbQueries.current.get(cacheKey) === normalizedQuery) return

    const timer = window.setTimeout(() => {
      void loadExternalKnowledgeBases(activeExternalSource, externalScope, normalizedQuery)
    }, 300)

    return () => window.clearTimeout(timer)
  }, [activeExternalSource, externalScope, loadExternalKnowledgeBases, searchValue])

  const loadExternalNodes = useCallback(
    async (source: ExternalKnowledgeSource, kb: ExternalKnowledgeBase) => {
      if (!source.listNodes) return
      const cacheKey = `${source.providerId}:${kb.knowledge_base_id}`
      setExternalNodesByKb(prev => {
        const next = new Map(prev)
        next.set(cacheKey, { loading: true, error: null, items: [] })
        return next
      })
      try {
        const items = await listAllExternalNodes(source, kb.knowledge_base_id)
        setExternalNodesByKb(prev => {
          const next = new Map(prev)
          next.set(cacheKey, { loading: false, error: null, items })
          return next
        })
      } catch (loadError) {
        setExternalNodesByKb(prev => {
          const next = new Map(prev)
          next.set(cacheKey, {
            loading: false,
            error: loadError instanceof Error ? loadError.message : t('fetch_error'),
            items: [],
          })
          return next
        })
      }
    },
    [t]
  )

  const selectInternalKb = (kb: KnowledgeBase) => {
    setActiveKnowledgeBase({ source: 'internal', knowledgeBase: kb })
    if (!internalTreeByKb.has(kb.id)) {
      void loadInternalTree(kb)
    }
  }

  const selectExternalKb = (source: ExternalKnowledgeSource, kb: ExternalKnowledgeBase) => {
    setActiveKnowledgeBase({ source: 'external', provider: source, knowledgeBase: kb })
    const cacheKey = `${source.providerId}:${kb.knowledge_base_id}`
    if (!externalNodesByKb.has(cacheKey)) {
      void loadExternalNodes(source, kb)
    }
  }

  const renderMiddleColumn = () => {
    if (loading) {
      return <PickerLoading label={t('picker.loading')} />
    }
    if (error) {
      return <PickerError message={error} onRetry={onRetry} />
    }

    if (activeSource === 'personal') {
      return (
        <div className="flex min-h-0 flex-col">
          {boundKnowledgeBaseItems.length > 0 ? (
            <div className="border-b border-border pb-2">
              <div className="px-3 pt-3 text-xs font-medium text-text-muted">
                {t('picker.boundKnowledgeBases')}
              </div>
              <KnowledgeBaseRows
                items={boundKnowledgeBaseItems}
                query={searchValue}
                selectedContexts={selectedContexts}
                onOpen={selectInternalKb}
                onToggle={toggleInternalKnowledgeBase}
              />
            </div>
          ) : null}
          <KnowledgeBaseRows
            items={groupedKnowledgeBases.personal}
            query={searchValue}
            selectedContexts={selectedContexts}
            onOpen={selectInternalKb}
            onToggle={toggleInternalKnowledgeBase}
          />
        </div>
      )
    }
    if (activeSource === 'organization') {
      return (
        <KnowledgeBaseRows
          items={groupedKnowledgeBases.organization}
          query={searchValue}
          selectedContexts={selectedContexts}
          onOpen={selectInternalKb}
          onToggle={toggleInternalKnowledgeBase}
        />
      )
    }
    if (activeSource === 'group') {
      if (!activeGroup) {
        return <PickerEmpty label={t('picker.selectKnowledgeBase')} />
      }
      const group = groupedKnowledgeBases.group.get(activeGroup)
      return (
        <div className="flex h-full min-h-0 flex-col">
          <KnowledgeBaseRows
            items={group?.items ?? []}
            query={searchValue}
            selectedContexts={selectedContexts}
            onOpen={selectInternalKb}
            onToggle={toggleInternalKnowledgeBase}
          />
        </div>
      )
    }

    if (activeExternalSource) {
      if (!externalScope) {
        return <PickerEmpty label={t('picker.selectKnowledgeBase')} />
      }

      const cacheKey = `${activeExternalSource.providerId}:${externalScope}`
      const state = externalKbByScope.get(cacheKey)
      const scopeStatus = externalScopeStatusesByProvider
        .get(activeExternalSource.providerId)
        ?.find(status => status.key === externalScope)
      const syncing =
        scopeStatus?.syncing ||
        syncingExternalScopes.has(`${activeExternalSource.providerId}:${externalScope}`)
      const supportsScopeSync =
        !state?.error &&
        (Boolean(activeExternalSource.syncScope) ||
          Boolean(activeExternalSource.getScopeStatuses) ||
          activeExternalSource.capabilities?.supportsSyncStatus === true)
      return (
        <div className="flex h-full min-h-0 flex-col">
          {supportsScopeSync ? (
            <ExternalScopeSyncToolbar
              source={activeExternalSource}
              scope={externalScope}
              status={scopeStatus}
              syncing={Boolean(syncing)}
              onSync={() => syncExternalScope(activeExternalSource, externalScope)}
            />
          ) : null}
          {state?.loading ? (
            <PickerLoading label={t('picker.loading')} />
          ) : state?.error ? (
            <PickerError
              message={state.error}
              testId={`knowledge-picker-${activeExternalSource.providerId}-catalog-retry-button`}
              onRetry={() =>
                loadExternalKnowledgeBases(activeExternalSource, externalScope, searchValue)
              }
            />
          ) : (state?.items ?? []).length === 0 && supportsScopeSync ? (
            <ExternalScopeEmptyState
              source={activeExternalSource}
              scope={externalScope}
              status={scopeStatus}
              syncing={Boolean(syncing)}
              onSync={() => syncExternalScope(activeExternalSource, externalScope)}
            />
          ) : (state?.items ?? []).length === 0 ? (
            <PickerEmpty label={t('picker.emptyKnowledgeBases')} />
          ) : (
            <ExternalKnowledgeBaseRows
              source={activeExternalSource}
              items={state?.items ?? []}
              selectedContexts={selectedContexts}
              onOpen={kb => selectExternalKb(activeExternalSource, kb)}
              onToggle={kb => toggleExternalKnowledgeBase(activeExternalSource, kb)}
            />
          )}
        </div>
      )
    }

    return <PickerEmpty label={t('picker.empty')} />
  }

  const renderSourceColumn = () => (
    <div className="space-y-1 p-2">
      {sourceRows.map(row => {
        const Icon = row.icon
        const active = activeSource === row.key
        const isGroupSource = row.key === 'group'
        const externalSource =
          row.key.startsWith('external:') && active
            ? browseableExternalSources.find(source => `external:${source.providerId}` === row.key)
            : undefined

        return (
          <React.Fragment key={row.key}>
            <LongTextTooltip content={row.label}>
              <button
                type="button"
                className={cn(
                  'flex min-h-11 w-full items-center justify-between rounded-md px-3 py-2 text-left',
                  active ? 'bg-primary/10 text-primary' : 'hover:bg-surface text-text-primary'
                )}
                onClick={() => {
                  setActiveSource(row.key)
                  setActiveGroup(null)
                  setExternalScope(null)
                  setActiveKnowledgeBase(null)
                }}
                data-testid={`knowledge-picker-source-${row.key}`}
                aria-label={row.label}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0" />
                  <TruncatedText
                    text={row.label}
                    focusable={false}
                    className="text-sm font-medium"
                  />
                </span>
                <Badge variant="secondary" size="sm">
                  {row.count}
                </Badge>
              </button>
            </LongTextTooltip>

            {isGroupSource && active
              ? groupEntries
                  .filter(([, group]) =>
                    groupMatchesSearch([group.name, group.displayName].join(' '), searchValue)
                  )
                  .map(([name, group]) => {
                    const groupActive = activeGroup === name
                    return (
                      <LongTextTooltip key={name} content={group.displayName}>
                        <button
                          type="button"
                          className={cn(
                            'flex min-h-11 w-full items-center justify-between rounded-md py-2 pl-8 pr-3 text-left',
                            groupActive
                              ? 'bg-primary/10 text-primary'
                              : 'hover:bg-surface text-text-primary'
                          )}
                          onClick={() => {
                            setActiveSource('group')
                            setActiveGroup(name)
                            setExternalScope(null)
                            setActiveKnowledgeBase(null)
                          }}
                          data-testid={`knowledge-picker-group-${name}`}
                          aria-label={group.displayName}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <Users className="h-4 w-4 shrink-0 text-text-muted" />
                            <TruncatedText
                              text={group.displayName}
                              focusable={false}
                              className="text-sm font-medium"
                            />
                          </span>
                          <Badge variant="secondary" size="sm">
                            {group.items.length}
                          </Badge>
                        </button>
                      </LongTextTooltip>
                    )
                  })
              : null}

            {externalSource
              ? getExternalKnowledgeScopes(externalSource)
                  .sort((a, b) => {
                    const orderA = a.displayOrder ?? Number.MAX_SAFE_INTEGER
                    const orderB = b.displayOrder ?? Number.MAX_SAFE_INTEGER
                    if (orderA !== orderB) return orderA - orderB
                    return getExternalScopeLabel(a, t).localeCompare(getExternalScopeLabel(b, t))
                  })
                  .map(scope => {
                    const ScopeIcon = getExternalScopeIcon(scope)
                    const scopeActive = externalScope === scope.key
                    return (
                      <LongTextTooltip key={scope.key} content={getExternalScopeLabel(scope, t)}>
                        <button
                          type="button"
                          className={cn(
                            'flex min-h-11 w-full items-center justify-between rounded-md py-2 pl-8 pr-3 text-left',
                            scopeActive
                              ? 'bg-primary/10 text-primary'
                              : 'hover:bg-surface text-text-primary'
                          )}
                          onClick={() => {
                            setActiveSource(`external:${externalSource.providerId}`)
                            setActiveGroup(null)
                            setExternalScope(scope.key)
                            setActiveKnowledgeBase(null)
                            void loadExternalKnowledgeBases(externalSource, scope.key, searchValue)
                          }}
                          data-testid={`knowledge-picker-external-scope-${scope.key}`}
                          aria-label={getExternalScopeLabel(scope, t)}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <ScopeIcon className="h-4 w-4 shrink-0 text-text-muted" />
                            <TruncatedText
                              text={getExternalScopeLabel(scope, t)}
                              focusable={false}
                              className="text-sm font-medium"
                            />
                          </span>
                          <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                        </button>
                      </LongTextTooltip>
                    )
                  })
              : null}
          </React.Fragment>
        )
      })}
    </div>
  )

  const renderDocumentColumn = () => {
    if (!activeKnowledgeBase) {
      return <PickerEmpty label={t('picker.selectKnowledgeBase')} />
    }

    if (activeKnowledgeBase.source === 'internal') {
      const kb = activeKnowledgeBase.knowledgeBase
      const state = internalTreeByKb.get(kb.id)
      const existing = getKnowledgeContext(selectedContexts, kb.id)
      const selectedDocIds = new Set(
        existing?.scope_restricted ? (existing.document_ids ?? []) : []
      )
      const selectedFolderIds = new Set(
        existing?.scope_restricted ? (existing.folder_ids ?? []) : []
      )
      const query = searchValue.trim()
      const searchResults = query
        ? flattenInternalSearchResults(state?.tree ?? []).filter(item =>
            matchesPathSearch(item.node.name, item.path, query)
          )
        : []
      return (
        <div className="flex h-full min-h-0 flex-col">
          <DocumentColumnHeader title={kb.name} documentCount={kb.document_count} />
          {state?.loading ? (
            <PickerLoading label={t('picker.loadingDocuments')} />
          ) : state?.error ? (
            <PickerError message={state.error} onRetry={() => loadInternalTree(kb)} />
          ) : (state?.tree ?? []).length === 0 ? (
            <PickerEmpty label={t('picker.emptyDocuments')} />
          ) : query ? (
            <InternalDocumentSearchResults
              items={searchResults}
              selectedDocIds={selectedDocIds}
              selectedFolderIds={selectedFolderIds}
              onToggleDocument={doc => toggleInternalDocument(kb, doc)}
              onToggleFolder={node => toggleInternalFolder(kb, node)}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {(state?.tree ?? []).map(node => (
                <InternalDocumentNode
                  key={node.id}
                  node={node}
                  depth={0}
                  disabled={false}
                  selectedDocIds={selectedDocIds}
                  selectedFolderIds={selectedFolderIds}
                  onToggleDocument={doc => toggleInternalDocument(kb, doc)}
                  onToggleFolder={node => toggleInternalFolder(kb, node)}
                />
              ))}
            </div>
          )}
        </div>
      )
    }

    const { provider, knowledgeBase } = activeKnowledgeBase
    const state = externalNodesByKb.get(`${provider.providerId}:${knowledgeBase.knowledge_base_id}`)
    const selectedNodeIds = new Set(
      selectedContexts
        .filter(
          (ctx): ctx is ExternalKnowledgeContext =>
            ctx.type === 'external_knowledge' &&
            ctx.ref.provider === provider.providerId &&
            ctx.ref.id === knowledgeBase.knowledge_base_id &&
            ctx.ref.target_type === 'document' &&
            Boolean(ctx.ref.node_id)
        )
        .map(ctx => ctx.ref.node_id as string)
    )
    const supportsDocumentSelection = provider.capabilities?.supportsDocumentSelection === true
    const display = getExternalKnowledgeBaseDisplay(provider, knowledgeBase)
    const query = searchValue.trim()
    const documentResults = query
      ? flattenExternalDocuments(state?.items ?? []).filter(item =>
          matchesPathSearch(item.node.name, item.path, query)
        )
      : []
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DocumentColumnHeader
          title={getExternalKnowledgeBaseLabel(display, knowledgeBase, t)}
          documentCount={knowledgeBase.document_count ?? 0}
        />
        {state?.loading ? (
          <PickerLoading label={t('picker.loadingDocuments')} />
        ) : state?.error ? (
          <PickerError
            message={state.error}
            onRetry={() => loadExternalNodes(provider, knowledgeBase)}
          />
        ) : (state?.items ?? []).length === 0 ? (
          <PickerEmpty label={t('picker.emptyDocuments')} />
        ) : query ? (
          <ExternalDocumentSearchResults
            items={documentResults}
            disabled={!supportsDocumentSelection}
            selectedNodeIds={selectedNodeIds}
            onToggleDocument={item => toggleExternalDocument(provider, knowledgeBase, item)}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {(state?.items ?? []).map(node => (
              <ExternalDocumentNode
                key={node.node_id}
                node={node}
                path={[]}
                depth={0}
                disabled={!supportsDocumentSelection}
                selectedNodeIds={selectedNodeIds}
                onToggleDocument={item => toggleExternalDocument(provider, knowledgeBase, item)}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,4fr)_minmax(0,5fr)_minmax(0,7fr)] overflow-hidden md:grid-cols-[180px_220px_minmax(0,1fr)] md:grid-rows-1"
      style={{
        height: 'min(520px, calc(var(--radix-popover-content-available-height) - 72px))',
      }}
      data-testid="knowledge-source-picker"
    >
      <div className="min-h-0 border-b border-border md:border-b-0 md:border-r">
        <div className="h-full min-h-0 overflow-y-auto">{renderSourceColumn()}</div>
      </div>

      <div className="min-h-0 border-b border-border md:border-b-0 md:border-r">
        <div className="h-full min-h-0 overflow-y-auto">{renderMiddleColumn()}</div>
      </div>

      <div className="min-h-0 overflow-hidden">{renderDocumentColumn()}</div>
    </div>
  )
}

function ExternalScopeSyncToolbar({
  source,
  scope,
  status,
  syncing,
  onSync,
}: {
  source: ExternalKnowledgeSource
  scope: ExternalKnowledgeScope
  status?: ExternalKnowledgeScopeStatus
  syncing: boolean
  onSync: () => void
}) {
  const { t } = useTranslation('chat')
  const configured = status?.configured ?? true
  const canSync = configured && Boolean(source.syncScope)
  const lastSyncedLabel = status?.lastSyncedAt
    ? t('dingtalkDocs.lastSynced', { time: new Date(status.lastSyncedAt).toLocaleString() })
    : t('dingtalkDocs.neverSynced')

  return (
    <div
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2"
      data-testid={`knowledge-picker-external-scope-sync-toolbar-${source.providerId}-${scope}`}
    >
      <span className="min-w-0 truncate text-xs text-text-muted">{lastSyncedLabel}</span>
      {canSync ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2 text-primary"
          disabled={syncing}
          onClick={onSync}
          data-testid={`knowledge-picker-external-scope-sync-button-${source.providerId}-${scope}`}
        >
          <RotateCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
          {syncing ? t('dingtalkDocs.syncing') : t('dingtalkDocs.sync')}
        </Button>
      ) : (
        <Link
          href={
            getExternalScopeActionHref(source, scope, 'configure') ||
            '/settings?section=integrations&tab=integrations'
          }
          className="inline-flex h-8 shrink-0 items-center gap-1.5 px-2 text-sm font-medium text-primary hover:text-primary/80"
          data-testid={`knowledge-picker-external-scope-configure-link-${source.providerId}-${scope}`}
        >
          {t('dingtalkDocs.goToConfigure')}
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  )
}

function ExternalScopeEmptyState({
  source,
  scope,
  status,
  syncing,
  onSync,
}: {
  source: ExternalKnowledgeSource
  scope: ExternalKnowledgeScope
  status?: ExternalKnowledgeScopeStatus
  syncing: boolean
  onSync: () => void
}) {
  const { t } = useTranslation('chat')
  const configured = status?.configured ?? true
  const message = status?.messageKey
    ? t(status.messageKey)
    : scope === 'organization'
      ? t('dingtalkDocs.wikispaceEmpty')
      : t('dingtalkDocs.empty')

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-sm text-text-muted">{message}</p>
      {configured && source.syncScope ? (
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="h-8 gap-1.5 px-3"
          disabled={syncing}
          onClick={onSync}
          data-testid={`knowledge-picker-external-scope-empty-sync-button-${source.providerId}-${scope}`}
        >
          <RotateCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
          {syncing ? t('dingtalkDocs.syncing') : t('dingtalkDocs.syncNow')}
        </Button>
      ) : (
        <Link
          href={
            getExternalScopeActionHref(source, scope, 'configure') ||
            '/settings?section=integrations&tab=integrations'
          }
          className="inline-flex h-8 items-center gap-1.5 px-2 text-sm font-medium text-primary hover:text-primary/80"
          data-testid={`knowledge-picker-external-scope-empty-configure-link-${source.providerId}-${scope}`}
        >
          {t('dingtalkDocs.goToConfigure')}
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  )
}

function KnowledgeBaseRows({
  items,
  query,
  selectedContexts,
  onOpen,
  onToggle,
}: {
  items: KnowledgeBase[]
  query: string
  selectedContexts: ContextItem[]
  onOpen: (kb: KnowledgeBase) => void
  onToggle: (kb: KnowledgeBase) => void
}) {
  const { t } = useTranslation('knowledge')
  const visibleItems = items.filter(item =>
    groupMatchesSearch([item.name, item.description ?? '', item.namespace].join(' '), query)
  )
  if (visibleItems.length === 0) {
    return <PickerEmpty label={t('picker.emptyKnowledgeBases')} />
  }

  return (
    <div className="space-y-1 p-2">
      {visibleItems.map(item => {
        const existing = getKnowledgeContext(selectedContexts, item.id)
        return (
          <LongTextTooltip key={item.id} content={item.name}>
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-surface"
              onClick={() => {
                onToggle(item)
                onOpen(item)
              }}
              data-testid={`knowledge-picker-kb-${item.id}`}
              aria-label={item.name}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Database className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0">
                  <TruncatedText
                    text={item.name}
                    focusable={false}
                    className="text-sm font-medium text-text-primary"
                  />
                  <span className="block text-xs text-text-muted">
                    {t('picker.count.documents', { count: item.document_count ?? 0 })}
                  </span>
                </span>
              </span>
              {existing ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
            </button>
          </LongTextTooltip>
        )
      })}
    </div>
  )
}

function ExternalKnowledgeBaseRows({
  source,
  items,
  selectedContexts,
  onOpen,
  onToggle,
}: {
  source: ExternalKnowledgeSource
  items: ExternalKnowledgeBase[]
  selectedContexts: ContextItem[]
  onOpen: (kb: ExternalKnowledgeBase) => void
  onToggle: (kb: ExternalKnowledgeBase) => void
}) {
  const { t } = useTranslation('knowledge')
  const visibleItems = items
  if (visibleItems.length === 0) {
    return <PickerEmpty label={t('picker.emptyKnowledgeBases')} />
  }

  return (
    <div className="space-y-1 p-2">
      {visibleItems.map(item => {
        const canSelectKnowledgeBase = supportsExternalKnowledgeBaseSelection(source)
        const display = getExternalKnowledgeBaseDisplay(source, item)
        const label = getExternalKnowledgeBaseLabel(display, item, t)
        const ItemIcon = getExternalDisplayIcon(display.icon ?? 'database')
        const existing = getExternalContext(
          selectedContexts,
          source.providerId,
          item.knowledge_base_id
        )
        const childSelected =
          getExternalChildContexts(selectedContexts, source.providerId, item.knowledge_base_id)
            .length > 0
        return (
          <LongTextTooltip key={item.knowledge_base_id} content={label}>
            <button
              type="button"
              className={cn(
                'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left',
                display.rowVariant === 'primary'
                  ? 'bg-primary/10 text-primary hover:bg-primary/15'
                  : 'hover:bg-surface'
              )}
              onClick={() => {
                if (canSelectKnowledgeBase) {
                  onToggle(item)
                }
                onOpen(item)
              }}
              data-testid={
                display.testId ?? `knowledge-picker-external-kb-${item.knowledge_base_id}`
              }
              aria-label={label}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ItemIcon className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0">
                  <TruncatedText
                    text={label}
                    focusable={false}
                    className={cn(
                      'text-sm font-medium',
                      display.rowVariant === 'primary' ? 'text-primary' : 'text-text-primary'
                    )}
                  />
                  <span className="block text-xs text-text-muted">
                    {t('picker.count.documents', { count: item.document_count ?? 0 })}
                  </span>
                </span>
              </span>
              {(canSelectKnowledgeBase && existing) || childSelected ? (
                <Check
                  className={cn(
                    'h-4 w-4 shrink-0 text-primary',
                    !existing && childSelected ? 'opacity-50' : ''
                  )}
                />
              ) : null}
            </button>
          </LongTextTooltip>
        )
      })}
    </div>
  )
}

function DocumentColumnHeader({ title, documentCount }: { title: string; documentCount: number }) {
  const { t } = useTranslation('knowledge')
  return (
    <div className="shrink-0 border-b border-border px-3 py-2">
      <div className="min-w-0">
        <TruncatedText text={title} className="text-sm font-semibold text-text-primary" />
        <div className="text-xs text-text-muted">
          {t('picker.count.documents', { count: documentCount })}
        </div>
      </div>
    </div>
  )
}

function PathLabel({ path }: { path: string[] }) {
  if (path.length === 0) return null
  const pathLabel = path.join(' / ')
  return <TruncatedText text={pathLabel} focusable={false} className="text-xs text-text-muted" />
}

function InternalDocumentSearchResults({
  items,
  selectedDocIds,
  selectedFolderIds,
  onToggleDocument,
  onToggleFolder,
}: {
  items: Array<{ node: InternalTreeNode; path: string[] }>
  selectedDocIds: Set<number>
  selectedFolderIds: Set<number>
  onToggleDocument: (doc: KnowledgeDocument) => void
  onToggleFolder: (node: InternalTreeNode) => void
}) {
  const { t } = useTranslation('knowledge')
  if (items.length === 0) {
    return <PickerEmpty label={t('picker.emptyDocuments')} />
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {items.map(({ node, path }) => {
        const isFolder = node.type === 'folder'
        const document = node.document
        const inheritedSelected = isCoveredBySelectedAncestorFolder(node, selectedFolderIds)
        const selected =
          isFolder && node.folderId !== undefined
            ? inheritedSelected || selectedFolderIds.has(node.folderId)
            : inheritedSelected || Boolean(document && selectedDocIds.has(document.id))
        const Icon = isFolder ? Folder : FileText
        const fullPath = isFolder ? path.join(' / ') : formatKnowledgePath(path, node.name)
        return (
          <LongTextTooltip key={node.id} content={fullPath}>
            <button
              type="button"
              disabled={inheritedSelected}
              aria-disabled={inheritedSelected}
              className={cn(
                'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-surface',
                selected ? 'bg-primary/10 text-primary' : '',
                inheritedSelected ? 'cursor-not-allowed opacity-70' : ''
              )}
              onClick={() => {
                if (isFolder) {
                  onToggleFolder(node)
                } else if (document && !inheritedSelected) {
                  onToggleDocument(document)
                }
              }}
              data-testid={
                isFolder
                  ? `knowledge-picker-search-folder-${node.folderId}`
                  : `knowledge-picker-document-node-document-${document?.id}`
              }
              aria-label={fullPath}
            >
              <span className="flex min-w-0 items-start gap-2">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0">
                  <TruncatedText
                    text={node.name}
                    tooltipText={fullPath}
                    focusable={false}
                    className="text-text-primary"
                  />
                  <PathLabel path={path} />
                </span>
              </span>
              {isFolder && !selected ? (
                <Badge variant="secondary" size="sm">
                  {node.documentCount}
                </Badge>
              ) : selected ? (
                <Check className="h-4 w-4 shrink-0 text-primary" />
              ) : null}
            </button>
          </LongTextTooltip>
        )
      })}
    </div>
  )
}

function ExternalDocumentSearchResults({
  items,
  disabled,
  selectedNodeIds,
  onToggleDocument,
}: {
  items: Array<{ node: ExternalKbNode; path: string[] }>
  disabled: boolean
  selectedNodeIds: Set<string>
  onToggleDocument: (node: ExternalKbNode) => void
}) {
  const { t } = useTranslation('knowledge')
  if (items.length === 0) {
    return <PickerEmpty label={t('picker.emptyDocuments')} />
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {items.map(({ node, path }) => {
        const selected = selectedNodeIds.has(node.node_id)
        const fullPath = formatKnowledgePath(path, node.name)
        return (
          <LongTextTooltip key={node.node_id} content={fullPath}>
            <button
              type="button"
              disabled={disabled}
              aria-disabled={disabled}
              className={cn(
                'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-surface',
                selected ? 'bg-primary/10 text-primary' : '',
                disabled ? 'cursor-not-allowed opacity-50' : ''
              )}
              onClick={() => onToggleDocument(node)}
              data-testid={`knowledge-picker-external-node-${node.node_id}`}
              aria-label={fullPath}
            >
              <span className="flex min-w-0 items-start gap-2">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0">
                  <TruncatedText
                    text={node.name}
                    tooltipText={fullPath}
                    focusable={false}
                    className="text-text-primary"
                  />
                  <PathLabel path={path} />
                </span>
              </span>
              {selected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
            </button>
          </LongTextTooltip>
        )
      })}
    </div>
  )
}

function InternalDocumentNode({
  node,
  depth,
  disabled,
  selectedDocIds,
  selectedFolderIds,
  onToggleDocument,
  onToggleFolder,
}: {
  node: InternalTreeNode
  depth: number
  disabled: boolean
  selectedDocIds: Set<number>
  selectedFolderIds: Set<number>
  onToggleDocument: (doc: KnowledgeDocument) => void
  onToggleFolder: (node: InternalTreeNode) => void
}) {
  const isFolder = node.type === 'folder'
  const inheritedSelected = isCoveredBySelectedAncestorFolder(node, selectedFolderIds)
  const folderSelected = Boolean(
    isFolder && (inheritedSelected || (node.folderId && selectedFolderIds.has(node.folderId)))
  )
  const containsSelected =
    hasSelectedInternalDocument(node, selectedDocIds) ||
    (isFolder && hasSelectedInternalFolder(node, selectedFolderIds))
  const [open, setOpen] = useState(depth < 1 || containsSelected)
  useEffect(() => {
    if (containsSelected) {
      setOpen(true)
    }
  }, [containsSelected])
  const selected =
    inheritedSelected || Boolean(node.document && selectedDocIds.has(node.document.id))
  const Icon = isFolder ? (open ? FolderOpen : Folder) : FileText
  const fullPath =
    node.type === 'folder' && node.path.length > 0
      ? node.path.join(' / ')
      : formatKnowledgePath(node.path, node.name)

  return (
    <div>
      {isFolder ? (
        <div
          className={cn(
            'flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 pr-2 text-left text-sm hover:bg-surface',
            folderSelected ? 'bg-primary/10 text-primary' : ''
          )}
          style={{ paddingLeft: 8 + depth * 16 }}
          data-testid={`knowledge-picker-document-node-${node.id}`}
        >
          <LongTextTooltip content={fullPath}>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-start gap-2 text-left"
              onClick={() => setOpen(!open)}
              aria-label={fullPath}
            >
              <ChevronRight
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted transition-transform',
                  open ? 'rotate-90' : ''
                )}
              />
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0">
                <TruncatedText
                  text={node.name}
                  tooltipText={fullPath}
                  focusable={false}
                  className="text-text-primary"
                />
              </span>
            </button>
          </LongTextTooltip>
          <span className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary" size="sm">
              {node.documentCount}
            </Badge>
            <button
              type="button"
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded text-text-muted hover:text-primary',
                inheritedSelected ? 'cursor-not-allowed opacity-70' : ''
              )}
              disabled={inheritedSelected}
              aria-disabled={inheritedSelected}
              onClick={() => {
                if (!inheritedSelected) {
                  onToggleFolder(node)
                }
              }}
              data-testid={`knowledge-picker-folder-scope-${node.folderId}`}
              title={fullPath}
              aria-label={fullPath}
            >
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded border border-border hover:border-primary/60 hover:bg-primary/10',
                  folderSelected ? 'border-primary bg-primary/10 text-primary' : ''
                )}
              >
                {folderSelected ? <Check className="h-3.5 w-3.5" /> : null}
              </span>
            </button>
          </span>
        </div>
      ) : (
        <LongTextTooltip content={fullPath}>
          <button
            type="button"
            className={cn(
              'flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 pr-2 text-left text-sm hover:bg-surface',
              selected ? 'bg-primary/10 text-primary' : '',
              disabled ? 'opacity-50' : '',
              inheritedSelected ? 'cursor-not-allowed opacity-70' : ''
            )}
            disabled={inheritedSelected}
            aria-disabled={inheritedSelected}
            style={{ paddingLeft: 8 + depth * 16 }}
            onClick={() => {
              if (node.document && !disabled && !inheritedSelected) {
                onToggleDocument(node.document)
              }
            }}
            data-testid={`knowledge-picker-document-node-${node.id}`}
            aria-label={fullPath}
          >
            <span className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0">
                <TruncatedText
                  text={node.name}
                  tooltipText={fullPath}
                  focusable={false}
                  className="text-text-primary"
                />
                <PathLabel path={node.path} />
              </span>
            </span>
            {selected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
          </button>
        </LongTextTooltip>
      )}
      {isFolder && open
        ? node.children.map(child => (
            <InternalDocumentNode
              key={child.id}
              node={child}
              depth={depth + 1}
              disabled={disabled}
              selectedDocIds={selectedDocIds}
              selectedFolderIds={selectedFolderIds}
              onToggleDocument={onToggleDocument}
              onToggleFolder={onToggleFolder}
            />
          ))
        : null}
    </div>
  )
}

function ExternalDocumentNode({
  node,
  path,
  depth,
  disabled,
  selectedNodeIds,
  onToggleDocument,
}: {
  node: ExternalKbNode
  path: string[]
  depth: number
  disabled: boolean
  selectedNodeIds: Set<string>
  onToggleDocument: (node: ExternalKbNode) => void
}) {
  const isFolder = node.node_type === 'folder'
  const containsSelected = hasSelectedExternalDocument(node, selectedNodeIds)
  const [open, setOpen] = useState(depth < 1 || containsSelected)
  useEffect(() => {
    if (containsSelected) {
      setOpen(true)
    }
  }, [containsSelected])
  const selected = selectedNodeIds.has(node.node_id)
  const Icon = isFolder ? (open ? FolderOpen : Folder) : FileText
  const documentCount = isFolder ? countExternalDocuments(node) : 1
  const documentDisabled = disabled && !isFolder
  const fullPath = formatKnowledgePath(path, node.name)

  return (
    <div>
      <LongTextTooltip content={fullPath}>
        <button
          type="button"
          disabled={documentDisabled}
          aria-disabled={documentDisabled}
          className={cn(
            'flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 pr-2 text-left text-sm hover:bg-surface',
            documentDisabled ? 'cursor-not-allowed opacity-50' : ''
          )}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => {
            if (isFolder) {
              setOpen(!open)
            } else if (!documentDisabled) {
              onToggleDocument(node)
            }
          }}
          data-testid={`knowledge-picker-external-node-${node.node_id}`}
          aria-label={fullPath}
        >
          <span className="flex min-w-0 items-start gap-2">
            {isFolder ? (
              <ChevronRight
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted transition-transform',
                  open ? 'rotate-90' : ''
                )}
              />
            ) : (
              <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
            <span className="min-w-0">
              <TruncatedText
                text={node.name}
                tooltipText={fullPath}
                focusable={false}
                className="text-text-primary"
              />
            </span>
          </span>
          {isFolder ? (
            <Badge variant="secondary" size="sm">
              {documentCount}
            </Badge>
          ) : selected ? (
            <Check className="h-4 w-4 shrink-0 text-primary" />
          ) : null}
        </button>
      </LongTextTooltip>
      {isFolder && open
        ? (node.children ?? []).map(child => (
            <ExternalDocumentNode
              key={child.node_id}
              node={child}
              path={[...path, node.name]}
              depth={depth + 1}
              disabled={disabled}
              selectedNodeIds={selectedNodeIds}
              onToggleDocument={onToggleDocument}
            />
          ))
        : null}
    </div>
  )
}

function PickerLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 py-8 text-sm text-text-muted">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

function PickerError({
  message,
  onRetry,
  testId,
}: {
  message: string
  onRetry: () => void
  testId?: string
}) {
  const { t } = useTranslation('knowledge')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <div className="text-sm text-red-500">{message}</div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} data-testid={testId}>
        <RotateCw className="mr-1.5 h-3.5 w-3.5" />
        {t('picker.retry')}
      </Button>
    </div>
  )
}

function PickerEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-text-muted">
      {label}
    </div>
  )
}
