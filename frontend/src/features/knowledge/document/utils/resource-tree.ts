// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeDocument, KnowledgeFolder } from '@/types/knowledge'

export type KnowledgeResourceNode =
  | {
      kind: 'folder'
      key: `folder:${number}`
      folderId: number
      name: string
      children: KnowledgeResourceNode[]
      documentCount: number
      loadedDocumentCount: number
      hasUnloadedDocuments: boolean
      createdAt?: string
      updatedAt?: string
    }
  | {
      kind: 'document'
      key: `document:${number}`
      documentId: number
      folderId: number
      name: string
      document: KnowledgeDocument
    }

export interface KnowledgeResourceRow {
  node: KnowledgeResourceNode
  depth: number
  parentKeys: string[]
}

export interface KnowledgeResourceTreeIndex {
  knownFolderIds: Set<number>
  folderById: Map<number, KnowledgeFolder>
  folderDescendantIds: Map<number, Set<number>>
  folderAncestorIds: Map<number, Set<number>>
  folderPathIds: Map<number, number[]>
}

function folderKey(folderId: number): `folder:${number}` {
  return `folder:${folderId}`
}

function documentKey(documentId: number): `document:${number}` {
  return `document:${documentId}`
}

function groupDocumentsByFolder(documents: KnowledgeDocument[]) {
  const documentsByFolderId = new Map<number, KnowledgeDocument[]>()
  for (const document of documents) {
    const folderId = document.folder_id ?? 0
    const folderDocuments = documentsByFolderId.get(folderId)
    if (folderDocuments) {
      folderDocuments.push(document)
    } else {
      documentsByFolderId.set(folderId, [document])
    }
  }
  return documentsByFolderId
}

function buildIndex(
  folders: KnowledgeFolder[],
  path: number[] = [],
  index: KnowledgeResourceTreeIndex = {
    knownFolderIds: new Set(),
    folderById: new Map(),
    folderDescendantIds: new Map(),
    folderAncestorIds: new Map(),
    folderPathIds: new Map(),
  }
) {
  for (const folder of folders) {
    const currentPath = [...path, folder.id]
    index.knownFolderIds.add(folder.id)
    index.folderById.set(folder.id, folder)
    index.folderPathIds.set(folder.id, currentPath)
    index.folderAncestorIds.set(folder.id, new Set(currentPath))
    buildIndex(folder.children, currentPath, index)
  }

  return index
}

function fillDescendantIds(folders: KnowledgeFolder[], index: KnowledgeResourceTreeIndex) {
  const collect = (folder: KnowledgeFolder): Set<number> => {
    const ids = new Set<number>([folder.id])
    for (const child of folder.children) {
      collect(child).forEach(id => ids.add(id))
    }
    index.folderDescendantIds.set(folder.id, ids)
    return ids
  }

  folders.forEach(collect)
}

function createDocumentNode(document: KnowledgeDocument): KnowledgeResourceNode {
  return {
    kind: 'document',
    key: documentKey(document.id),
    documentId: document.id,
    folderId: document.folder_id ?? 0,
    name: document.name,
    document,
  }
}

function convertFolderToNode(
  folder: KnowledgeFolder,
  documentsByFolderId: Map<number, KnowledgeDocument[]>
): KnowledgeResourceNode {
  const childFolders = folder.children.map(child => convertFolderToNode(child, documentsByFolderId))
  const directDocuments = (documentsByFolderId.get(folder.id) ?? []).map(createDocumentNode)
  const loadedDocumentCount = directDocuments.length
  const documentCount = folder.total_document_count ?? folder.document_count

  return {
    kind: 'folder',
    key: folderKey(folder.id),
    folderId: folder.id,
    name: folder.name,
    children: [...childFolders, ...directDocuments],
    documentCount,
    loadedDocumentCount,
    hasUnloadedDocuments: documentCount > loadedDocumentCount,
    createdAt: folder.created_at,
    updatedAt: folder.updated_at,
  }
}

export function buildKnowledgeResourceTree(
  folders: KnowledgeFolder[],
  documents: KnowledgeDocument[]
) {
  const documentsByFolderId = groupDocumentsByFolder(documents)
  const index = buildIndex(folders)
  fillDescendantIds(folders, index)

  const folderNodes = folders.map(folder => convertFolderToNode(folder, documentsByFolderId))
  const rootDocuments = (documentsByFolderId.get(0) ?? []).map(createDocumentNode)
  const orphanDocuments = documents
    .filter(document => {
      const folderId = document.folder_id ?? 0
      return folderId > 0 && !index.knownFolderIds.has(folderId)
    })
    .map(createDocumentNode)

  return {
    nodes: [...folderNodes, ...rootDocuments, ...orphanDocuments],
    index,
  }
}

export function flattenKnowledgeResourceRows(
  nodes: KnowledgeResourceNode[],
  expandedKeys: Set<string>,
  depth = 0,
  parentKeys: string[] = []
): KnowledgeResourceRow[] {
  const rows: KnowledgeResourceRow[] = []
  for (const node of nodes) {
    rows.push({ node, depth, parentKeys })
    if (node.kind === 'folder' && expandedKeys.has(node.key)) {
      rows.push(
        ...flattenKnowledgeResourceRows(node.children, expandedKeys, depth + 1, [
          ...parentKeys,
          node.key,
        ])
      )
    }
  }
  return rows
}

export function getDefaultExpandedFolderKeys(folders: KnowledgeFolder[]): Set<string> {
  return new Set(folders.map(folder => folderKey(folder.id)))
}

export function getFolderPathKeys(
  index: KnowledgeResourceTreeIndex,
  folderId: number | undefined
): Set<string> {
  if (folderId === undefined) return new Set()
  return new Set((index.folderPathIds.get(folderId) ?? []).map(id => folderKey(id)))
}

export function getResultDocumentFolderKeys(
  index: KnowledgeResourceTreeIndex,
  documents: KnowledgeDocument[]
): Set<string> {
  const keys = new Set<string>()
  for (const document of documents) {
    const folderId = document.folder_id ?? 0
    for (const id of index.folderPathIds.get(folderId) ?? []) {
      keys.add(folderKey(id))
    }
  }
  return keys
}

export function collectFolderAndDescendantIds(
  folders: KnowledgeFolder[],
  targetId: number
): Set<number> {
  const { index } = buildKnowledgeResourceTree(folders, [])
  return new Set(index.folderDescendantIds.get(targetId) ?? [])
}

export function collectFolderAndAncestorIds(
  folders: KnowledgeFolder[],
  targetId: number
): Set<number> {
  const { index } = buildKnowledgeResourceTree(folders, [])
  return new Set(index.folderAncestorIds.get(targetId) ?? [])
}

export function folderTreeContainsId(folders: KnowledgeFolder[], targetId: number | undefined) {
  if (targetId === undefined) return true
  const { index } = buildKnowledgeResourceTree(folders, [])
  return index.folderAncestorIds.has(targetId)
}

export function deletedFolderAffectsActiveFolder(
  folders: KnowledgeFolder[],
  deletedFolderId: number,
  activeFolderId: number | undefined
) {
  if (activeFolderId === undefined) return false
  return collectFolderAndDescendantIds(folders, deletedFolderId).has(activeFolderId)
}
