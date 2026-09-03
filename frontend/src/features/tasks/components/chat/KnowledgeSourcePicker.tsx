// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  Building2,
  ChevronRight,
  Cloud,
  Database,
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
import { TruncatedText } from '@/components/common/long-text'
import { SelectionIndicator } from '@/components/ui/selection-indicator'
import { KnowledgeBaseIcon } from '@/features/knowledge/document/components/KnowledgeBaseIcon'
import { DocumentFormatIcon } from '@/components/icons/DocumentFormatIcon'
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
  ExternalKnowledgeScopeDescriptor,
  ExternalKnowledgeSource,
} from '@/features/knowledge/externalKnowledgeSourceRegistry'
import { isSameExternalKnowledgeScope } from '@/features/knowledge/externalKnowledgeSelection'
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
import { useDingTalkDocTrees } from './DingTalkDocContextSelector'
import { buildExternalContextId } from './selectedKnowledge'
import {
  countDingTalkNodes,
  DingTalkDocsRootRow,
  DingTalkDocumentColumn,
  DingTalkWikispaceRows,
  useDingTalkKnowledgeSelection,
} from './DingTalkKnowledgePicker'
import { KnowledgeSelectionControl } from './KnowledgeSelectionControl'
import {
  KnowledgeSourcePickerLayout,
  ResponsiveDrilldownHeader,
  ResponsiveSecondaryOption,
  ResponsiveSecondaryOptions,
} from './KnowledgeSourcePickerResponsive'
import {
  type KnowledgeSourceKey,
  useKnowledgePickerNavigation,
} from './useKnowledgePickerNavigation'

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

const INTERNAL_DOCUMENT_PAGE_SIZE = 200
const DEFAULT_EXTERNAL_SCOPE_ICON = 'cloud'

interface KnowledgeSourcePickerProps {
  groupedKnowledgeBases: GroupedKnowledgeBases
  boundKnowledgeBases: BoundKnowledgeBaseDetail[]
  externalSources: ExternalKnowledgeSource[]
  selectedContexts: ContextItem[]
  searchValue: string
  onSearchValueChange: (value: string) => void
  loading: boolean
  error: string | null
  onRetry: () => void
  onSelect: (context: ContextItem) => void
  onDeselect: (id: number | string) => void
  onSelectMultiple?: (contexts: ContextItem[]) => void
  onDeselectMultiple?: (ids: (number | string)[]) => void
  onReplaceContexts: (idsToRemove: (number | string)[], contextsToAdd: ContextItem[]) => void
}

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

function collectInternalDocuments(node: InternalTreeNode): KnowledgeDocument[] {
  if (node.document) return [node.document]
  return node.children.flatMap(collectInternalDocuments)
}

function findInternalDocumentNode(
  nodes: InternalTreeNode[],
  documentId: number
): InternalTreeNode | undefined {
  for (const node of nodes) {
    if (node.document?.id === documentId) return node
    const match = findInternalDocumentNode(node.children, documentId)
    if (match) return match
  }
  return undefined
}

function findInternalFolderNode(
  nodes: InternalTreeNode[],
  folderId: number
): InternalTreeNode | undefined {
  for (const node of nodes) {
    if (node.folderId === folderId) return node
    const match = findInternalFolderNode(node.children, folderId)
    if (match) return match
  }
  return undefined
}

function getEffectiveInternalDocuments(
  existing: KnowledgeBaseContext,
  tree: InternalTreeNode[],
  documents: KnowledgeDocument[]
): KnowledgeDocument[] {
  if (!existing.scope_restricted) return documents

  const selectedDocumentIds = new Set(existing.document_ids ?? [])
  const selectedFolderIds = new Set(existing.folder_ids ?? [])
  const selectedByFolder = tree
    .flatMap(function collectSelectedFolderDocuments(node): KnowledgeDocument[] {
      if (node.type === 'folder' && node.folderId && selectedFolderIds.has(node.folderId)) {
        return collectInternalDocuments(node)
      }
      return node.children.flatMap(collectSelectedFolderDocuments)
    })
    .map(document => document.id)
  selectedByFolder.forEach(id => selectedDocumentIds.add(id))
  return documents.filter(document => selectedDocumentIds.has(document.id))
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

function collectExternalDocuments(node: ExternalKbNode): ExternalKbNode[] {
  if (node.node_type !== 'folder') return [node]
  return (node.children ?? []).flatMap(collectExternalDocuments)
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
      icon: DEFAULT_EXTERNAL_SCOPE_ICON,
    },
  ]
}

function getExternalScopeIcon(scope: ExternalKnowledgeScopeDescriptor) {
  if (scope.icon === 'personal') return User
  if (scope.icon === 'organization') return Building2
  return Cloud
}

function getExternalScopeLabel(
  scope: ExternalKnowledgeScopeDescriptor,
  t: (key: string) => string
) {
  if (scope.label) return scope.label
  if (scope.labelKey) return t(scope.labelKey)
  return scope.key
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

function countSelectedInternalDocuments(
  node: InternalTreeNode,
  wholeKnowledgeBaseSelected: boolean,
  selectedDocIds: Set<number>,
  selectedFolderIds: Set<number>
): number {
  const inheritedSelected =
    wholeKnowledgeBaseSelected ||
    isCoveredBySelectedAncestorFolder(node, selectedFolderIds) ||
    Boolean(node.folderId && selectedFolderIds.has(node.folderId))
  if (inheritedSelected) return node.documentCount
  if (node.document) return selectedDocIds.has(node.document.id) ? 1 : 0
  return node.children.reduce(
    (total, child) =>
      total +
      countSelectedInternalDocuments(
        child,
        wholeKnowledgeBaseSelected,
        selectedDocIds,
        selectedFolderIds
      ),
    0
  )
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

function getKnowledgeContext(
  selectedContexts: ContextItem[],
  knowledgeBaseId: number
): KnowledgeBaseContext | undefined {
  return selectedContexts.find(
    (ctx): ctx is KnowledgeBaseContext =>
      ctx.type === 'knowledge_base' && ctx.id === knowledgeBaseId
  )
}

function toExternalKnowledgeBaseRef(
  source: ExternalKnowledgeSource,
  knowledgeBase: ExternalKnowledgeBase
): ExternalKnowledgeRef {
  return source.toRef
    ? source.toRef(knowledgeBase)
    : {
        provider: source.providerId,
        mode: 'explicit',
        id: knowledgeBase.knowledge_base_id,
        name: knowledgeBase.knowledge_base_name,
        scope: knowledgeBase.scope ?? undefined,
      }
}

function getExternalContext(
  selectedContexts: ContextItem[],
  knowledgeBaseRef: ExternalKnowledgeRef
): ExternalKnowledgeContext | undefined {
  return selectedContexts.find(
    (ctx): ctx is ExternalKnowledgeContext =>
      ctx.type === 'external_knowledge' &&
      isSameExternalKnowledgeScope(ctx.ref, knowledgeBaseRef) &&
      (!ctx.ref.target_type || ctx.ref.target_type === 'knowledge_base')
  )
}

function getExternalDocumentContext(
  selectedContexts: ContextItem[],
  knowledgeBaseRef: ExternalKnowledgeRef,
  nodeId: string
): ExternalKnowledgeContext | undefined {
  return selectedContexts.find(
    (ctx): ctx is ExternalKnowledgeContext =>
      ctx.type === 'external_knowledge' &&
      isSameExternalKnowledgeScope(ctx.ref, knowledgeBaseRef) &&
      ctx.ref.target_type === 'document' &&
      ctx.ref.node_id === nodeId
  )
}

function getExternalChildContexts(
  selectedContexts: ContextItem[],
  knowledgeBaseRef: ExternalKnowledgeRef
): ExternalKnowledgeContext[] {
  return selectedContexts.filter(
    (ctx): ctx is ExternalKnowledgeContext =>
      ctx.type === 'external_knowledge' &&
      isSameExternalKnowledgeScope(ctx.ref, knowledgeBaseRef) &&
      Boolean(ctx.ref.target_type) &&
      ctx.ref.target_type !== 'knowledge_base'
  )
}

function toExternalDocumentContext(
  source: ExternalKnowledgeSource,
  kb: ExternalKnowledgeBase,
  node: ExternalKbNode
): ExternalKnowledgeContext {
  const ref: ExternalKnowledgeRef = {
    ...toExternalKnowledgeBaseRef(source, kb),
    target_type: 'document',
    node_id: node.node_id,
    document_id: stripTypedExternalId(node.raw_id ?? node.node_id),
    parent_id: stripTypedExternalId(node.parent_id),
    target_name: node.name,
  }
  return {
    type: 'external_knowledge',
    id: buildExternalContextId(ref),
    name: node.name,
    ref,
  }
}

export function KnowledgeSourcePicker({
  groupedKnowledgeBases,
  boundKnowledgeBases,
  externalSources,
  selectedContexts,
  searchValue,
  onSearchValueChange,
  loading,
  error,
  onRetry,
  onSelect,
  onDeselect,
  onSelectMultiple,
  onDeselectMultiple,
  onReplaceContexts,
}: KnowledgeSourcePickerProps) {
  const { t } = useTranslation('knowledge')
  const { t: tChat } = useTranslation('chat')
  const { toast } = useToast()
  const browseableExternalSources = useMemo(
    () => externalSources.filter(source => source.listKnowledgeBases),
    [externalSources]
  )
  const {
    activeSource,
    activeGroup,
    externalScope,
    activeKnowledgeBase,
    activeDingTalkSpace,
    selectSource,
    selectGroup,
    selectExternalScope: navigateToExternalScope,
    selectDingTalkSection,
    openInternalKnowledgeBase,
    openExternalKnowledgeBase,
    openDingTalkSpace,
    back: navigateBack,
  } = useKnowledgePickerNavigation()
  const dingtalkTrees = useDingTalkDocTrees({ enabled: activeSource.startsWith('dingtalk') })
  const {
    selectedIds: selectedDingTalkIds,
    toggleNode: toggleDingTalkNode,
    toggleNodeList: toggleDingTalkNodeList,
  } = useDingTalkKnowledgeSelection({
    selectedContexts,
    onSelect,
    onDeselect,
    onSelectMultiple,
    onDeselectMultiple,
  })

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
      setExternalKnowledgeBaseCounts(new Map())
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
    if (!externalScope) return
    if (!activeExternalSource) {
      selectSource(activeSource)
      return
    }
    const scopes = getExternalKnowledgeScopes(activeExternalSource)
    if (scopes.some(scope => scope.key === externalScope)) return
    selectSource(activeSource)
  }, [activeExternalSource, activeSource, externalScope, selectSource])

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
        key: 'personal' as KnowledgeSourceKey,
        label: t('picker.sources.personal'),
        count: groupedKnowledgeBases.personal.length,
        icon: User,
      },
      {
        key: 'group' as KnowledgeSourceKey,
        label: t('picker.sources.group'),
        count: groupedKnowledgeBases.group.size,
        icon: Users,
      },
      {
        key: 'organization' as KnowledgeSourceKey,
        label: t('picker.sources.organization'),
        count: groupedKnowledgeBases.organization.length,
        icon: Building2,
      },
      {
        key: 'dingtalk' as KnowledgeSourceKey,
        label: tChat('dingtalkDocs.tabTitle'),
        count: 2,
        icon: MessageSquareText,
      },
      ...browseableExternalSources.map(source => ({
        key: `external:${source.providerId}` as KnowledgeSourceKey,
        label: source.label ?? source.providerId,
        count: externalKnowledgeBaseCounts.get(source.providerId) ?? 0,
        icon: Cloud,
      })),
    ],
    [
      browseableExternalSources,
      externalKnowledgeBaseCounts,
      groupedKnowledgeBases.group.size,
      groupedKnowledgeBases.organization.length,
      groupedKnowledgeBases.personal.length,
      t,
      tChat,
    ]
  )

  const replaceContexts = onReplaceContexts

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
          source: source.label ?? source.providerId,
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
    const treeState = internalTreeByKb.get(kb.id)
    const documentNode = findInternalDocumentNode(treeState?.tree ?? [], doc.id)
    const coveredByFolder = Boolean(
      existing?.scope_restricted &&
      documentNode &&
      isCoveredBySelectedAncestorFolder(documentNode, new Set(existing.folder_ids ?? []))
    )

    if (existing && treeState && (!existing.scope_restricted || coveredByFolder)) {
      const nextDocuments = getEffectiveInternalDocuments(
        existing,
        treeState.tree,
        treeState.documents
      ).filter(document => document.id !== doc.id)
      replaceContexts(
        [existing.id],
        nextDocuments.length > 0 ? [toKnowledgeContext(kb, { documents: nextDocuments })] : []
      )
      return
    }

    const existingIds = existing?.scope_restricted ? (existing.document_ids ?? []) : []
    const existingFolderIds = existing?.scope_restricted ? (existing.folder_ids ?? []) : []
    const existingFolderNames = existing?.scope_restricted ? (existing.folder_names ?? []) : []
    const selected = existingIds.includes(doc.id)
    const nextIds = selected ? existingIds.filter(id => id !== doc.id) : [...existingIds, doc.id]

    if (nextIds.length === 0 && existingFolderIds.length === 0) {
      if (existing) onDeselect(existing.id)
      return
    }

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
    const treeState = internalTreeByKb.get(kb.id)
    const effectivelySelected = Boolean(
      existing &&
      node.documentCount > 0 &&
      countSelectedInternalDocuments(
        node,
        !existing.scope_restricted,
        new Set(existingDocumentIds),
        new Set(existingFolderIds)
      ) === node.documentCount
    )

    if (existing && treeState && effectivelySelected) {
      const removedDocumentIds = new Set(
        collectInternalDocuments(node).map(document => document.id)
      )
      const nextSelectedDocuments = getEffectiveInternalDocuments(
        existing,
        treeState.tree,
        treeState.documents
      ).filter(document => !removedDocumentIds.has(document.id))
      const remainingFolders = existingFolderIds.flatMap((folderId, index) => {
        if (folderId === node.folderId) return []
        const folderNode = findInternalFolderNode(treeState.tree, folderId)
        if (!folderNode) {
          return []
        }
        const folderDocuments = collectInternalDocuments(folderNode)
        if (folderDocuments.some(document => removedDocumentIds.has(document.id))) {
          return []
        }
        return [{ id: folderId, name: existingFolderNames[index], documents: folderDocuments }]
      })
      const remainingFolderDocumentIds = new Set(
        remainingFolders.flatMap(folder => folder.documents.map(document => document.id))
      )
      const nextExplicitDocuments = nextSelectedDocuments.filter(
        document => !remainingFolderDocumentIds.has(document.id)
      )
      replaceContexts(
        [existing.id],
        nextSelectedDocuments.length > 0 || remainingFolders.length > 0
          ? [
              toKnowledgeContext(kb, {
                documents: nextExplicitDocuments,
                folderIds: remainingFolders.map(folder => folder.id),
                folderNames: remainingFolders
                  .map(folder => folder.name)
                  .filter((name): name is string => Boolean(name)),
                includeSubfolders: existing.include_subfolders ?? true,
              }),
            ]
          : []
      )
      return
    }

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
    const ref = toExternalKnowledgeBaseRef(source, kb)
    const existing = getExternalContext(selectedContexts, ref)
    const childContexts = getExternalChildContexts(selectedContexts, ref)
    if (existing) {
      replaceContexts([existing.id, ...childContexts.map(ctx => ctx.id)], [])
      return
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
    const knowledgeBaseRef = toExternalKnowledgeBaseRef(source, kb)
    const wholeKb = getExternalContext(selectedContexts, knowledgeBaseRef)
    const existing = getExternalDocumentContext(selectedContexts, knowledgeBaseRef, node.node_id)
    if (existing) {
      onDeselect(existing.id)
      return
    }

    const context = toExternalDocumentContext(source, kb, node)
    if (wholeKb) {
      const treeState = externalNodesByKb.get(`${source.providerId}:${kb.knowledge_base_id}`)
      const contexts = flattenExternalDocuments(treeState?.items ?? [])
        .map(item => item.node)
        .filter(documentNode => documentNode.node_id !== node.node_id)
        .map(documentNode => toExternalDocumentContext(source, kb, documentNode))
      if (
        !canAddExternalRefs(
          source,
          [wholeKb.id],
          contexts.map(item => item.ref)
        )
      ) {
        return
      }
      replaceContexts([wholeKb.id], contexts)
      return
    }
    if (!canAddExternalRefs(source, [], [context.ref])) {
      return
    }
    onSelect(context)
  }

  const toggleExternalFolder = (
    source: ExternalKnowledgeSource,
    kb: ExternalKnowledgeBase,
    node: ExternalKbNode
  ) => {
    if (node.node_type !== 'folder') return
    const knowledgeBaseRef = toExternalKnowledgeBaseRef(source, kb)
    const wholeKb = getExternalContext(selectedContexts, knowledgeBaseRef)
    const childContexts = getExternalChildContexts(selectedContexts, knowledgeBaseRef)
    const descendants = collectExternalDocuments(node)
    if (descendants.length === 0) return
    const descendantIds = new Set(descendants.map(document => document.node_id))
    const selectedDescendants = childContexts.filter(
      context => context.ref.node_id && descendantIds.has(context.ref.node_id)
    )

    if (wholeKb) {
      const treeState = externalNodesByKb.get(`${source.providerId}:${kb.knowledge_base_id}`)
      const contexts = flattenExternalDocuments(treeState?.items ?? [])
        .map(item => item.node)
        .filter(document => !descendantIds.has(document.node_id))
        .map(document => toExternalDocumentContext(source, kb, document))
      if (
        !canAddExternalRefs(
          source,
          [wholeKb.id],
          contexts.map(item => item.ref)
        )
      ) {
        return
      }
      replaceContexts([wholeKb.id], contexts)
      return
    }

    if (selectedDescendants.length === descendants.length) {
      replaceContexts(
        selectedDescendants.map(context => context.id),
        []
      )
      return
    }

    const selectedNodeIds = new Set(childContexts.map(context => context.ref.node_id))
    const contextsToAdd = descendants
      .filter(document => !selectedNodeIds.has(document.node_id))
      .map(document => toExternalDocumentContext(source, kb, document))
    if (
      !canAddExternalRefs(
        source,
        [],
        contextsToAdd.map(item => item.ref)
      )
    )
      return
    replaceContexts([], contextsToAdd)
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
  const externalKbRequestIds = useRef(new Map<string, number>())
  const externalKbQueries = useRef(new Map<string, string>())
  const [externalNodesByKb, setExternalNodesByKb] = useState<
    Map<string, { loading: boolean; error: string | null; items: ExternalKbNode[] }>
  >(new Map())

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
      const requestId = (externalKbRequestIds.current.get(cacheKey) ?? 0) + 1
      const normalizedQuery = query.trim()
      externalKbRequestIds.current.set(cacheKey, requestId)
      externalKbQueries.current.set(cacheKey, normalizedQuery)
      setExternalKbByScope(prev => {
        const next = new Map(prev)
        next.set(cacheKey, { loading: true, error: null, items: [] })
        return next
      })
      try {
        const items = await listAllExternalKnowledgeBases(source, {
          scope,
          query: normalizedQuery || undefined,
        })
        if (externalKbRequestIds.current.get(cacheKey) !== requestId) return
        setExternalKbByScope(prev => {
          const next = new Map(prev)
          next.set(cacheKey, { loading: false, error: null, items })
          return next
        })
      } catch (loadError) {
        if (externalKbRequestIds.current.get(cacheKey) !== requestId) return
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
    onSearchValueChange('')
    openInternalKnowledgeBase(kb)
    if (!internalTreeByKb.has(kb.id)) {
      void loadInternalTree(kb)
    }
  }

  const selectExternalKb = (source: ExternalKnowledgeSource, kb: ExternalKnowledgeBase) => {
    onSearchValueChange('')
    openExternalKnowledgeBase(source, kb)
    const cacheKey = `${source.providerId}:${kb.knowledge_base_id}`
    if (!externalNodesByKb.has(cacheKey)) {
      void loadExternalNodes(source, kb)
    }
  }

  const selectExternalScope = (source: ExternalKnowledgeSource, scope: ExternalKnowledgeScope) => {
    navigateToExternalScope(source.providerId, scope)
    void loadExternalKnowledgeBases(source, scope, searchValue)
  }

  const filteredGroupEntries = groupEntries.filter(([, group]) =>
    groupMatchesSearch([group.name, group.displayName].join(' '), searchValue)
  )

  const dingtalkSections = [
    {
      key: 'dingtalk:docs' as const,
      label: tChat('dingtalkDocs.myDocsTab'),
      count: dingtalkTrees.totalCount,
      icon: FileText,
    },
    {
      key: 'dingtalk:wikispace' as const,
      label: tChat('dingtalkDocs.wikispaceTab'),
      count: dingtalkTrees.wikispaceTotalCount,
      icon: BookOpen,
    },
  ]

  const renderResponsiveGroupOptions = () => {
    if (filteredGroupEntries.length === 0) {
      return (
        <div className="lg:hidden">
          <PickerEmpty label={t('picker.emptyGroups')} />
        </div>
      )
    }

    return (
      <ResponsiveSecondaryOptions title={t('picker.selectGroup')} testId="group">
        {filteredGroupEntries.map(([name, group]) => (
          <ResponsiveSecondaryOption
            key={name}
            icon={Users}
            label={group.displayName}
            count={group.items.length}
            onClick={() => selectGroup(name)}
            testId={`knowledge-picker-responsive-group-${name}`}
          />
        ))}
      </ResponsiveSecondaryOptions>
    )
  }

  const renderResponsiveDingTalkOptions = () => (
    <ResponsiveSecondaryOptions title={t('picker.selectCategory')} testId="dingtalk">
      {dingtalkSections.map(section => (
        <ResponsiveSecondaryOption
          key={section.key}
          icon={section.icon}
          label={section.label}
          count={section.count}
          onClick={() => selectDingTalkSection(section.key)}
          testId={
            section.key === 'dingtalk:docs'
              ? 'knowledge-picker-responsive-dingtalk-docs'
              : 'knowledge-picker-responsive-dingtalk-wikispace'
          }
        />
      ))}
    </ResponsiveSecondaryOptions>
  )

  const renderResponsiveExternalScopeOptions = (source: ExternalKnowledgeSource) => (
    <ResponsiveSecondaryOptions title={t('picker.selectScope')} testId="external">
      {getExternalKnowledgeScopes(source).map(scope => (
        <ResponsiveSecondaryOption
          key={scope.key}
          icon={getExternalScopeIcon(scope)}
          label={getExternalScopeLabel(scope, t)}
          onClick={() => selectExternalScope(source, scope.key)}
          testId={`knowledge-picker-responsive-external-scope-${scope.key}`}
        />
      ))}
    </ResponsiveSecondaryOptions>
  )

  const renderMiddleColumn = () => {
    const isInternalSource =
      activeSource === 'personal' || activeSource === 'group' || activeSource === 'organization'

    if (isInternalSource && loading) {
      return <PickerLoading label={t('picker.loading')} />
    }
    if (isInternalSource && error) {
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
                activeId={
                  activeKnowledgeBase?.source === 'internal'
                    ? activeKnowledgeBase.knowledgeBase.id
                    : undefined
                }
                onOpen={selectInternalKb}
                onToggle={toggleInternalKnowledgeBase}
              />
            </div>
          ) : null}
          <KnowledgeBaseRows
            items={groupedKnowledgeBases.personal}
            query={searchValue}
            selectedContexts={selectedContexts}
            activeId={
              activeKnowledgeBase?.source === 'internal'
                ? activeKnowledgeBase.knowledgeBase.id
                : undefined
            }
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
          activeId={
            activeKnowledgeBase?.source === 'internal'
              ? activeKnowledgeBase.knowledgeBase.id
              : undefined
          }
          onOpen={selectInternalKb}
          onToggle={toggleInternalKnowledgeBase}
        />
      )
    }
    if (activeSource === 'group') {
      if (!activeGroup) {
        return (
          <>
            {renderResponsiveGroupOptions()}
            <div className="hidden h-full lg:block">
              <PickerEmpty label={t('picker.selectKnowledgeBase')} />
            </div>
          </>
        )
      }
      const group = groupedKnowledgeBases.group.get(activeGroup)
      return (
        <div className="flex h-full min-h-0 flex-col">
          <ResponsiveDrilldownHeader
            label={group?.displayName ?? activeGroup}
            onBack={navigateBack}
            testId="knowledge-picker-responsive-group-back"
          />
          <KnowledgeBaseRows
            items={group?.items ?? []}
            query={searchValue}
            selectedContexts={selectedContexts}
            activeId={
              activeKnowledgeBase?.source === 'internal'
                ? activeKnowledgeBase.knowledgeBase.id
                : undefined
            }
            onOpen={selectInternalKb}
            onToggle={toggleInternalKnowledgeBase}
          />
        </div>
      )
    }

    if (activeSource === 'dingtalk') {
      return (
        <>
          {renderResponsiveDingTalkOptions()}
          <div className="hidden h-full lg:block">
            <PickerEmpty label={t('picker.selectKnowledgeBase')} />
          </div>
        </>
      )
    }

    if (activeSource === 'dingtalk:docs') {
      return (
        <DingTalkDocsRootRow
          nodes={dingtalkTrees.nodes}
          totalCount={dingtalkTrees.totalCount}
          loading={dingtalkTrees.loading}
          error={dingtalkTrees.error}
          configured={dingtalkTrees.isConfigured}
          selectedIds={selectedDingTalkIds}
          syncing={dingtalkTrees.syncing}
          lastSyncedAt={dingtalkTrees.lastSyncedAt}
          onRetry={dingtalkTrees.fetchDocs}
          onSync={dingtalkTrees.syncDocs}
          onToggle={() => toggleDingTalkNodeList(dingtalkTrees.nodes)}
        />
      )
    }

    if (activeSource === 'dingtalk:wikispace') {
      return (
        <DingTalkWikispaceRows
          nodes={dingtalkTrees.wikispaceNodes}
          query={searchValue}
          loading={dingtalkTrees.wikispaceLoading}
          error={dingtalkTrees.wikispaceError}
          configured={dingtalkTrees.wikispaceConfigured}
          selectedIds={selectedDingTalkIds}
          activeNode={activeDingTalkSpace}
          syncing={dingtalkTrees.wikispaceSyncing}
          lastSyncedAt={dingtalkTrees.wikispaceLastSyncedAt}
          onRetry={dingtalkTrees.fetchWikispace}
          onSync={dingtalkTrees.syncWikispace}
          onOpen={openDingTalkSpace}
          onToggle={node => toggleDingTalkNode(node, node)}
        />
      )
    }

    if (activeExternalSource) {
      if (!externalScope) {
        return (
          <>
            {renderResponsiveExternalScopeOptions(activeExternalSource)}
            <div className="hidden h-full lg:block">
              <PickerEmpty label={t('picker.selectKnowledgeBase')} />
            </div>
          </>
        )
      }

      const cacheKey = `${activeExternalSource.providerId}:${externalScope}`
      const state = externalKbByScope.get(cacheKey)
      const activeScope = getExternalKnowledgeScopes(activeExternalSource).find(
        scope => scope.key === externalScope
      )
      return (
        <div className="flex min-h-0 flex-col">
          <ResponsiveDrilldownHeader
            label={
              activeScope
                ? getExternalScopeLabel(activeScope, t)
                : (activeExternalSource.label ?? activeExternalSource.providerId)
            }
            onBack={navigateBack}
            testId="knowledge-picker-responsive-external-scope-back"
          />
          {state?.loading ? (
            <PickerLoading label={t('picker.loading')} />
          ) : state?.error ? (
            <PickerError
              message={state.error}
              onRetry={() =>
                loadExternalKnowledgeBases(activeExternalSource, externalScope, searchValue)
              }
            />
          ) : (
            <ExternalKnowledgeBaseRows
              source={activeExternalSource}
              items={state?.items ?? []}
              selectedContexts={selectedContexts}
              activeId={
                activeKnowledgeBase?.source === 'external'
                  ? activeKnowledgeBase.knowledgeBase.knowledge_base_id
                  : undefined
              }
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
    <div className="flex gap-2 overflow-x-auto p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:block lg:space-y-1 lg:overflow-x-visible">
      {sourceRows.map(row => {
        const Icon = row.icon
        const active =
          activeSource === row.key ||
          (row.key === 'dingtalk' && activeSource.startsWith('dingtalk'))
        const isGroupSource = row.key === 'group'
        const externalSource =
          row.key.startsWith('external:') && active
            ? browseableExternalSources.find(source => `external:${source.providerId}` === row.key)
            : undefined

        return (
          <React.Fragment key={row.key}>
            <button
              type="button"
              className={cn(
                'flex min-h-11 items-center py-2 text-left',
                'max-lg:w-auto max-lg:shrink-0 max-lg:justify-start max-lg:gap-2 max-lg:rounded-lg max-lg:border max-lg:border-border max-lg:px-3',
                'lg:w-full lg:justify-between lg:rounded-md lg:px-3',
                active ? 'bg-primary/10 text-primary' : 'hover:bg-surface text-text-primary'
              )}
              onClick={() => selectSource(row.key)}
              data-testid={
                row.key === 'dingtalk'
                  ? 'knowledge-picker-dingtalk-parent'
                  : `knowledge-picker-source-${row.key}`
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="h-4 w-4 shrink-0" />
                <TruncatedText text={row.label} focusable={false} className="text-sm font-medium" />
              </span>
              <Badge variant="secondary" size="sm">
                {row.count}
              </Badge>
            </button>

            {isGroupSource && active
              ? filteredGroupEntries.map(([name, group]) => {
                  const groupActive = activeGroup === name
                  return (
                    <button
                      key={name}
                      type="button"
                      className={cn(
                        'hidden min-h-11 items-center py-2 text-left lg:flex',
                        'lg:w-full lg:justify-between lg:rounded-md lg:pl-8 lg:pr-3',
                        groupActive
                          ? 'bg-primary/10 text-primary'
                          : 'hover:bg-surface text-text-primary'
                      )}
                      onClick={() => selectGroup(name)}
                      data-testid={`knowledge-picker-group-${name}`}
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
                  )
                })
              : null}

            {externalSource
              ? getExternalKnowledgeScopes(externalSource).map(scope => {
                  const ScopeIcon = getExternalScopeIcon(scope)
                  const scopeActive = externalScope === scope.key
                  return (
                    <button
                      key={scope.key}
                      type="button"
                      className={cn(
                        'hidden min-h-11 items-center py-2 text-left lg:flex',
                        'lg:w-full lg:justify-between lg:rounded-md lg:pl-8 lg:pr-3',
                        scopeActive
                          ? 'bg-primary/10 text-primary'
                          : 'hover:bg-surface text-text-primary'
                      )}
                      onClick={() => selectExternalScope(externalSource, scope.key)}
                      data-testid={`knowledge-picker-external-scope-${scope.key}`}
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
                  )
                })
              : null}

            {row.key === 'dingtalk' && activeSource.startsWith('dingtalk')
              ? dingtalkSections.map(section => {
                  const SectionIcon = section.icon
                  const sectionActive = activeSource === section.key
                  return (
                    <button
                      key={section.key}
                      type="button"
                      className={cn(
                        'hidden min-h-11 items-center py-2 text-left lg:flex',
                        'lg:w-full lg:justify-between lg:rounded-md lg:pl-8 lg:pr-3',
                        sectionActive
                          ? 'bg-primary/10 text-primary'
                          : 'hover:bg-surface text-text-primary'
                      )}
                      onClick={() => selectDingTalkSection(section.key)}
                      data-testid={
                        section.key === 'dingtalk:docs'
                          ? 'knowledge-picker-dingtalk-docs'
                          : 'knowledge-picker-dingtalk-wikispace'
                      }
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <SectionIcon
                          className={cn(
                            'h-4 w-4 shrink-0',
                            sectionActive ? 'text-primary' : 'text-text-muted'
                          )}
                        />
                        <TruncatedText
                          text={section.label}
                          focusable={false}
                          className="text-sm font-medium"
                        />
                      </span>
                      <Badge variant="secondary" size="sm">
                        {section.count}
                      </Badge>
                    </button>
                  )
                })
              : null}
          </React.Fragment>
        )
      })}
    </div>
  )

  const renderDocumentColumn = () => {
    if (activeSource === 'dingtalk') {
      return <PickerEmpty label={t('picker.selectKnowledgeBase')} />
    }

    if (activeSource === 'dingtalk:docs') {
      return (
        <DingTalkDocumentColumn
          title={tChat('dingtalkDocs.allDocs')}
          nodes={dingtalkTrees.nodes}
          totalCount={dingtalkTrees.totalCount}
          loading={dingtalkTrees.loading}
          error={dingtalkTrees.error}
          configured={dingtalkTrees.isConfigured}
          notConfiguredLabel={tChat('dingtalkDocs.notConfigured')}
          emptyLabel={tChat('dingtalkDocs.empty')}
          query={searchValue}
          selectedIds={selectedDingTalkIds}
          syncing={dingtalkTrees.syncing}
          onRetry={dingtalkTrees.fetchDocs}
          onSync={dingtalkTrees.syncDocs}
          onToggle={toggleDingTalkNode}
          onToggleAll={toggleDingTalkNodeList}
        />
      )
    }

    if (activeSource === 'dingtalk:wikispace') {
      if (!activeDingTalkSpace) {
        return <PickerEmpty label={t('picker.selectKnowledgeBase')} />
      }
      return (
        <DingTalkDocumentColumn
          title={activeDingTalkSpace.name}
          nodes={activeDingTalkSpace.children ?? []}
          totalCount={countDingTalkNodes(activeDingTalkSpace.children ?? [])}
          loading={dingtalkTrees.wikispaceLoading}
          error={dingtalkTrees.wikispaceError}
          configured={dingtalkTrees.wikispaceConfigured}
          notConfiguredLabel={tChat('dingtalkDocs.wikispaceNotConfigured')}
          emptyLabel={tChat('dingtalkDocs.wikispaceEmpty')}
          query={searchValue}
          selectedIds={selectedDingTalkIds}
          syncing={dingtalkTrees.wikispaceSyncing}
          onRetry={dingtalkTrees.fetchWikispace}
          onSync={dingtalkTrees.syncWikispace}
          onToggle={node => toggleDingTalkNode(node, activeDingTalkSpace)}
          onToggleAll={nodes => toggleDingTalkNodeList(nodes, activeDingTalkSpace)}
        />
      )
    }

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
      const wholeKnowledgeBaseSelected = Boolean(existing && !existing.scope_restricted)
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
              wholeKnowledgeBaseSelected={wholeKnowledgeBaseSelected}
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
                  wholeKnowledgeBaseSelected={wholeKnowledgeBaseSelected}
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
    const knowledgeBaseRef = toExternalKnowledgeBaseRef(provider, knowledgeBase)
    const selectedNodeIds = new Set(
      selectedContexts
        .filter(
          (ctx): ctx is ExternalKnowledgeContext =>
            ctx.type === 'external_knowledge' &&
            isSameExternalKnowledgeScope(ctx.ref, knowledgeBaseRef) &&
            ctx.ref.target_type === 'document' &&
            Boolean(ctx.ref.node_id)
        )
        .map(ctx => ctx.ref.node_id as string)
    )
    const supportsDocumentSelection = provider.capabilities?.supportsDocumentSelection === true
    const wholeKnowledgeBaseSelected = Boolean(
      getExternalContext(selectedContexts, knowledgeBaseRef)
    )
    const query = searchValue.trim()
    const documentResults = query
      ? flattenExternalDocuments(state?.items ?? []).filter(item =>
          matchesPathSearch(item.node.name, item.path, query)
        )
      : []
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DocumentColumnHeader
          title={knowledgeBase.knowledge_base_name}
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
            wholeKnowledgeBaseSelected={wholeKnowledgeBaseSelected}
            selectedNodeIds={selectedNodeIds}
            onToggleDocument={item => toggleExternalDocument(provider, knowledgeBase, item)}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {(state?.items ?? []).map(node => (
              <ExternalDocumentNode
                key={node.node_id}
                node={node}
                depth={0}
                disabled={!supportsDocumentSelection}
                wholeKnowledgeBaseSelected={wholeKnowledgeBaseSelected}
                selectedNodeIds={selectedNodeIds}
                onToggleDocument={item => toggleExternalDocument(provider, knowledgeBase, item)}
                onToggleFolder={item => toggleExternalFolder(provider, knowledgeBase, item)}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const hasResponsiveDocumentView =
    activeKnowledgeBase !== null ||
    activeSource === 'dingtalk:docs' ||
    (activeSource === 'dingtalk:wikispace' && activeDingTalkSpace !== null)

  return (
    <KnowledgeSourcePickerLayout
      hasDocumentView={hasResponsiveDocumentView}
      sourceColumn={renderSourceColumn()}
      knowledgeBaseColumn={renderMiddleColumn()}
      documentColumn={renderDocumentColumn()}
      onBack={navigateBack}
    />
  )
}

function KnowledgeBaseRows({
  items,
  query,
  selectedContexts,
  activeId,
  onOpen,
  onToggle,
}: {
  items: KnowledgeBase[]
  query: string
  selectedContexts: ContextItem[]
  activeId?: number
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
        const selectionState = !existing
          ? 'unchecked'
          : existing.scope_restricted
            ? 'mixed'
            : 'checked'
        return (
          <div
            key={item.id}
            className={cn(
              'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-surface',
              activeId === item.id && 'bg-primary/10 lg:bg-transparent'
            )}
          >
            <button
              type="button"
              className="group flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => onOpen(item)}
              data-testid={`knowledge-picker-kb-${item.id}`}
            >
              <KnowledgeBaseIcon kbType={item.kb_type} className="h-4 w-4 shrink-0" />
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
              <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted lg:hidden" />
            </button>
            <KnowledgeSelectionControl
              state={selectionState}
              onToggle={() => onToggle(item)}
              label={`${t('picker.selectWholeKb')} ${item.name}`}
              testId={`knowledge-picker-kb-select-${item.id}`}
            />
          </div>
        )
      })}
    </div>
  )
}

function ExternalKnowledgeBaseRows({
  source,
  items,
  selectedContexts,
  activeId,
  onOpen,
  onToggle,
}: {
  source: ExternalKnowledgeSource
  items: ExternalKnowledgeBase[]
  selectedContexts: ContextItem[]
  activeId?: string
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
        const knowledgeBaseRef = toExternalKnowledgeBaseRef(source, item)
        const existing = getExternalContext(selectedContexts, knowledgeBaseRef)
        const childSelected =
          getExternalChildContexts(selectedContexts, knowledgeBaseRef).length > 0
        const selectionState = existing ? 'checked' : childSelected ? 'mixed' : 'unchecked'
        return (
          <div
            key={item.knowledge_base_id}
            className={cn(
              'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-surface',
              activeId === item.knowledge_base_id && 'bg-primary/10 lg:bg-transparent'
            )}
          >
            <button
              type="button"
              className="group flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => onOpen(item)}
              data-testid={`knowledge-picker-external-kb-${item.knowledge_base_id}`}
            >
              <Database className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0">
                <TruncatedText
                  text={item.knowledge_base_name}
                  focusable={false}
                  className="text-sm font-medium text-text-primary"
                />
                <span className="block text-xs text-text-muted">
                  {t('picker.count.documents', { count: item.document_count ?? 0 })}
                </span>
              </span>
              <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted lg:hidden" />
            </button>
            {canSelectKnowledgeBase ? (
              <KnowledgeSelectionControl
                state={selectionState}
                onToggle={() => onToggle(item)}
                label={`${t('picker.selectWholeKb')} ${item.knowledge_base_name}`}
                testId={`knowledge-picker-external-kb-select-${item.knowledge_base_id}`}
              />
            ) : null}
          </div>
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
        <TruncatedText
          text={title}
          focusable={false}
          className="text-sm font-semibold text-text-primary"
        />
        <div className="text-xs text-text-muted">
          {t('picker.count.documents', { count: documentCount })}
        </div>
      </div>
    </div>
  )
}

function formatKnowledgePath(path: string[], name: string) {
  return path.length > 0 ? [...path, name].join(' / ') : name
}

function PathLabel({ path }: { path: string[] }) {
  if (path.length === 0) return null
  return <span className="block truncate text-xs text-text-muted">{path.join(' / ')}</span>
}

function InternalDocumentSearchResults({
  items,
  wholeKnowledgeBaseSelected,
  selectedDocIds,
  selectedFolderIds,
  onToggleDocument,
  onToggleFolder,
}: {
  items: Array<{ node: InternalTreeNode; path: string[] }>
  wholeKnowledgeBaseSelected: boolean
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
        const inheritedSelected =
          wholeKnowledgeBaseSelected || isCoveredBySelectedAncestorFolder(node, selectedFolderIds)
        const selectedDocumentCount = countSelectedInternalDocuments(
          node,
          wholeKnowledgeBaseSelected,
          selectedDocIds,
          selectedFolderIds
        )
        const selected =
          isFolder && node.folderId !== undefined
            ? inheritedSelected || selectedFolderIds.has(node.folderId)
            : inheritedSelected || Boolean(document && selectedDocIds.has(document.id))
        const folderPartiallySelected =
          isFolder && selectedDocumentCount > 0 && selectedDocumentCount < node.documentCount
        const folderSelected =
          isFolder &&
          (selected || (selectedDocumentCount === node.documentCount && node.documentCount > 0))
        return (
          <button
            key={node.id}
            type="button"
            role={isFolder ? 'checkbox' : undefined}
            aria-checked={
              isFolder ? (folderPartiallySelected ? 'mixed' : folderSelected) : undefined
            }
            aria-pressed={!isFolder ? selected : undefined}
            className={cn(
              'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-surface',
              selected ? 'bg-primary/10 text-primary' : ''
            )}
            onClick={() => {
              if (isFolder) {
                onToggleFolder(node)
              } else if (document) {
                onToggleDocument(document)
              }
            }}
            data-testid={
              isFolder
                ? `knowledge-picker-search-folder-${node.folderId}`
                : `knowledge-picker-document-node-document-${document?.id}`
            }
          >
            <span className="flex min-w-0 items-start gap-2">
              {isFolder ? (
                <Folder className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
              ) : (
                <DocumentFormatIcon
                  extension={document?.file_extension}
                  sourceType={document?.source_type}
                  className="mt-0.5"
                />
              )}
              <span className="min-w-0">
                <TruncatedText
                  text={node.name}
                  tooltipText={formatKnowledgePath(path, node.name)}
                  focusable={false}
                  className="text-text-primary"
                />
                <PathLabel path={path} />
              </span>
            </span>
            {isFolder ? (
              <span className="flex items-center gap-2">
                <Badge variant="secondary" size="sm">
                  {node.documentCount}
                </Badge>
                <SelectionIndicator
                  checked={folderSelected}
                  indeterminate={folderPartiallySelected}
                />
              </span>
            ) : (
              <SelectionIndicator checked={selected} />
            )}
          </button>
        )
      })}
    </div>
  )
}

function ExternalDocumentSearchResults({
  items,
  disabled,
  wholeKnowledgeBaseSelected,
  selectedNodeIds,
  onToggleDocument,
}: {
  items: Array<{ node: ExternalKbNode; path: string[] }>
  disabled: boolean
  wholeKnowledgeBaseSelected: boolean
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
        const selected = wholeKnowledgeBaseSelected || selectedNodeIds.has(node.node_id)
        return (
          <button
            key={node.node_id}
            type="button"
            disabled={disabled}
            aria-disabled={disabled}
            aria-pressed={selected}
            className={cn(
              'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-surface',
              selected ? 'bg-primary/10 text-primary' : '',
              disabled ? 'cursor-not-allowed opacity-70' : ''
            )}
            onClick={() => onToggleDocument(node)}
            data-testid={`knowledge-picker-external-node-${node.node_id}`}
          >
            <span className="flex min-w-0 items-start gap-2">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
              <span className="min-w-0">
                <TruncatedText
                  text={node.name}
                  tooltipText={formatKnowledgePath(path, node.name)}
                  focusable={false}
                  className="text-text-primary"
                />
                <PathLabel path={path} />
              </span>
            </span>
            <SelectionIndicator checked={selected} />
          </button>
        )
      })}
    </div>
  )
}

function InternalDocumentNode({
  node,
  depth,
  disabled,
  wholeKnowledgeBaseSelected,
  selectedDocIds,
  selectedFolderIds,
  onToggleDocument,
  onToggleFolder,
}: {
  node: InternalTreeNode
  depth: number
  disabled: boolean
  wholeKnowledgeBaseSelected: boolean
  selectedDocIds: Set<number>
  selectedFolderIds: Set<number>
  onToggleDocument: (doc: KnowledgeDocument) => void
  onToggleFolder: (node: InternalTreeNode) => void
}) {
  const isFolder = node.type === 'folder'
  const inheritedSelected =
    wholeKnowledgeBaseSelected || isCoveredBySelectedAncestorFolder(node, selectedFolderIds)
  const selectedDocumentCount = countSelectedInternalDocuments(
    node,
    wholeKnowledgeBaseSelected,
    selectedDocIds,
    selectedFolderIds
  )
  const folderScopeSelected = Boolean(
    isFolder && (inheritedSelected || (node.folderId && selectedFolderIds.has(node.folderId)))
  )
  const folderSelected = Boolean(
    isFolder &&
    (folderScopeSelected ||
      (node.documentCount > 0 && selectedDocumentCount === node.documentCount))
  )
  const folderPartiallySelected =
    isFolder && selectedDocumentCount > 0 && selectedDocumentCount < node.documentCount
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
  const FolderIcon = open ? FolderOpen : Folder

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
          <button
            type="button"
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
            onClick={() => setOpen(!open)}
          >
            <ChevronRight
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted transition-transform',
                open ? 'rotate-90' : ''
              )}
            />
            <FolderIcon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
            <span className="min-w-0">
              <TruncatedText text={node.name} focusable={false} className="text-text-primary" />
            </span>
          </button>
          <span className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary" size="sm">
              {node.documentCount}
            </Badge>
            <KnowledgeSelectionControl
              state={folderSelected ? 'checked' : folderPartiallySelected ? 'mixed' : 'unchecked'}
              onToggle={() => onToggleFolder(node)}
              testId={`knowledge-picker-folder-scope-${node.folderId}`}
              label={node.name}
            />
          </span>
        </div>
      ) : (
        <button
          type="button"
          className={cn(
            'flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 pr-2 text-left text-sm hover:bg-surface',
            selected ? 'bg-primary/10 text-primary' : '',
            disabled ? 'opacity-50' : ''
          )}
          aria-pressed={selected}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => {
            if (node.document && !disabled) {
              onToggleDocument(node.document)
            }
          }}
          data-testid={`knowledge-picker-document-node-${node.id}`}
        >
          <span className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <DocumentFormatIcon
              extension={node.document?.file_extension}
              sourceType={node.document?.source_type}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <TruncatedText
                text={node.name}
                tooltipText={formatKnowledgePath(node.path, node.name)}
                focusable={false}
                className="text-text-primary"
              />
              <PathLabel path={node.path} />
            </span>
          </span>
          <SelectionIndicator checked={selected} />
        </button>
      )}
      {isFolder && open
        ? node.children.map(child => (
            <InternalDocumentNode
              key={child.id}
              node={child}
              depth={depth + 1}
              disabled={disabled}
              wholeKnowledgeBaseSelected={wholeKnowledgeBaseSelected}
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
  depth,
  disabled,
  wholeKnowledgeBaseSelected,
  selectedNodeIds,
  onToggleDocument,
  onToggleFolder,
}: {
  node: ExternalKbNode
  depth: number
  disabled: boolean
  wholeKnowledgeBaseSelected: boolean
  selectedNodeIds: Set<string>
  onToggleDocument: (node: ExternalKbNode) => void
  onToggleFolder: (node: ExternalKbNode) => void
}) {
  const isFolder = node.node_type === 'folder'
  const containsSelected = hasSelectedExternalDocument(node, selectedNodeIds)
  const [open, setOpen] = useState(depth < 1 || containsSelected)
  useEffect(() => {
    if (containsSelected) {
      setOpen(true)
    }
  }, [containsSelected])
  const descendantDocuments = isFolder ? collectExternalDocuments(node) : []
  const selectedDocumentCount = wholeKnowledgeBaseSelected
    ? descendantDocuments.length
    : descendantDocuments.filter(document => selectedNodeIds.has(document.node_id)).length
  const folderSelected =
    isFolder &&
    descendantDocuments.length > 0 &&
    selectedDocumentCount === descendantDocuments.length
  const folderPartiallySelected =
    isFolder && selectedDocumentCount > 0 && selectedDocumentCount < descendantDocuments.length
  const selected = wholeKnowledgeBaseSelected || selectedNodeIds.has(node.node_id)
  const Icon = isFolder ? (open ? FolderOpen : Folder) : FileText
  const documentCount = isFolder ? countExternalDocuments(node) : 1
  const documentDisabled = disabled && !isFolder

  return (
    <div>
      {isFolder ? (
        <div
          className="group flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 pr-2 text-left text-sm hover:bg-surface"
          style={{ paddingLeft: 8 + depth * 16 }}
          data-testid={`knowledge-picker-external-node-${node.node_id}`}
        >
          <button
            type="button"
            className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => setOpen(!open)}
          >
            <ChevronRight
              className={cn(
                'mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted transition-transform',
                open ? 'rotate-90' : ''
              )}
            />
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
            <span className="min-w-0">
              <TruncatedText text={node.name} focusable={false} className="text-text-primary" />
            </span>
          </button>
          <span className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary" size="sm">
              {documentCount}
            </Badge>
            <KnowledgeSelectionControl
              state={folderSelected ? 'checked' : folderPartiallySelected ? 'mixed' : 'unchecked'}
              disabled={disabled || descendantDocuments.length === 0}
              label={node.name}
              testId={`knowledge-picker-external-folder-scope-${node.node_id}`}
              onToggle={() => onToggleFolder(node)}
            />
          </span>
        </div>
      ) : (
        <button
          type="button"
          disabled={documentDisabled}
          aria-disabled={documentDisabled}
          aria-pressed={selected}
          className={cn(
            'group flex min-h-11 w-full items-center justify-between gap-2 rounded-md py-2 pr-2 text-left text-sm hover:bg-surface',
            documentDisabled ? 'cursor-not-allowed opacity-50' : ''
          )}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => onToggleDocument(node)}
          data-testid={`knowledge-picker-external-node-${node.node_id}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
            <span className="min-w-0">
              <TruncatedText text={node.name} focusable={false} className="text-text-primary" />
            </span>
          </span>
          <SelectionIndicator checked={selected} />
        </button>
      )}
      {isFolder && open
        ? (node.children ?? []).map(child => (
            <ExternalDocumentNode
              key={child.node_id}
              node={child}
              depth={depth + 1}
              disabled={disabled}
              wholeKnowledgeBaseSelected={wholeKnowledgeBaseSelected}
              selectedNodeIds={selectedNodeIds}
              onToggleDocument={onToggleDocument}
              onToggleFolder={onToggleFolder}
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

function PickerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation('knowledge')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <div className="text-sm text-red-500">{message}</div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
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
