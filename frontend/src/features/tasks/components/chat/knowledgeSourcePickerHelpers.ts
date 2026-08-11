// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import type {
  ExternalKnowledgeContext,
  ExternalKnowledgeRef,
  KnowledgeBaseContext,
} from '@/types/context'
import type { ExternalKbNode, ExternalKnowledgeBase } from '@/types/external-knowledge'
import type { KnowledgeDocument } from '@/types/knowledge'

export interface InternalTreeNode {
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

export function collectInternalDocuments(node: InternalTreeNode): KnowledgeDocument[] {
  if (node.document) return [node.document]
  return node.children.flatMap(collectInternalDocuments)
}

export function findInternalDocumentNode(
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

export function findInternalFolderNode(
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

export function getEffectiveInternalDocuments(
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

export function hasSelectedInternalDocument(
  node: InternalTreeNode,
  selectedDocIds: Set<number>
): boolean {
  if (node.document) return selectedDocIds.has(node.document.id)
  return node.children.some(child => hasSelectedInternalDocument(child, selectedDocIds))
}

export function hasSelectedInternalFolder(
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

export function isCoveredBySelectedAncestorFolder(
  node: InternalTreeNode,
  selectedFolderIds: Set<number>
): boolean {
  const ancestorFolderIds =
    node.type === 'folder' ? node.folderPathIds.slice(0, -1) : node.folderPathIds
  return ancestorFolderIds.some(folderId => selectedFolderIds.has(folderId))
}

export function countSelectedInternalDocuments(
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

export function collectExternalDocuments(node: ExternalKbNode): ExternalKbNode[] {
  if (node.node_type !== 'folder') return [node]
  return (node.children ?? []).flatMap(collectExternalDocuments)
}

export function buildExternalContextId(ref: ExternalKnowledgeRef): string {
  const targetType = ref.target_type ?? 'knowledge_base'
  if (targetType !== 'knowledge_base') {
    const targetId = ref.node_id ?? ref.document_id ?? 'unknown'
    return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}:${targetType}:${targetId}`
  }
  return `external:${ref.provider}:${ref.mode}:${ref.id ?? 'all'}`
}

export function toExternalKnowledgeBaseRef(
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

export function toExternalDocumentContext(
  source: ExternalKnowledgeSource,
  knowledgeBase: ExternalKnowledgeBase,
  node: ExternalKbNode
): ExternalKnowledgeContext {
  const ref: ExternalKnowledgeRef = {
    ...toExternalKnowledgeBaseRef(source, knowledgeBase),
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

function stripTypedExternalId(value?: string | null): string | undefined {
  if (!value) return undefined
  const index = value.indexOf(':')
  return index >= 0 ? value.slice(index + 1) : value
}
