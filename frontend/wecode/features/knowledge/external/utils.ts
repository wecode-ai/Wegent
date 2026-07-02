// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  ExternalKbNode,
  ExternalKnowledgeBase,
  ExternalKnowledgePreview,
  ExternalKnowledgeProvider,
} from '@wecode/types/external-knowledge'
import {
  getExternalKnowledgePreview,
  listExternalKnowledgeBases,
} from '@wecode/api/external-knowledge'

export const DEFAULT_PROVIDER = 'ap'

export async function getExternalKnowledgeBaseCount(provider = DEFAULT_PROVIDER) {
  const response = await listExternalKnowledgeBases(provider, {
    scope: 'all',
    limit: 1,
    offset: 0,
  })
  return response.total ?? response.items.length
}

export function isMissingEmployeeError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: number; code?: string; message?: string }
  const message = candidate.message?.toLowerCase() ?? ''
  return (
    candidate.code === 'employee_id_required' ||
    candidate.code === 'missing_employee_id' ||
    candidate.code === 'employee_not_bound' ||
    candidate.code === 'employee_required' ||
    (candidate.status === 403 && (message.includes('employee') || message.includes('工号')))
  )
}

export function isFolderNode(node: ExternalKbNode) {
  return node.node_type === 'folder' || node.node_id.startsWith('folder:')
}

export function isDocumentNode(node: ExternalKbNode) {
  return node.node_type === 'document' || node.node_id.startsWith('document:')
}

export function getExternalNodeRawId(node: ExternalKbNode) {
  if (node.raw_id) return node.raw_id
  const separatorIndex = node.node_id.indexOf(':')
  return separatorIndex >= 0 ? node.node_id.slice(separatorIndex + 1) : node.node_id
}

export function getExternalTypedIdRawValue(id?: string | null) {
  if (!id) return null
  const separatorIndex = id.indexOf(':')
  return separatorIndex >= 0 ? id.slice(separatorIndex + 1) : id
}

export function getExternalFolderRequestId(folderId: string | null, folders: ExternalKbNode[]) {
  if (!folderId) return null
  const folder = folders.find(
    item =>
      item.node_id === folderId ||
      item.raw_id === folderId ||
      getExternalNodeRawId(item) === folderId
  )
  if (folder) return getExternalNodeRawId(folder)
  const separatorIndex = folderId.indexOf(':')
  return separatorIndex >= 0 ? folderId.slice(separatorIndex + 1) : folderId
}

export async function resolveExternalNodePreview(
  provider: ExternalKnowledgeProvider,
  knowledgeBase: ExternalKnowledgeBase,
  node: ExternalKbNode
): Promise<ExternalKnowledgePreview> {
  if (node.preview) {
    return node.preview
  }

  return getExternalKnowledgePreview(provider, {
    kb_id: knowledgeBase.knowledge_base_id,
    node_id: node.node_id,
    folder_id: getExternalTypedIdRawValue(node.parent_id),
  })
}

export function isExternalChildOfFolder(candidate: ExternalKbNode, parent: ExternalKbNode) {
  const parentKeys = new Set([parent.node_id, parent.raw_id, getExternalNodeRawId(parent)])
  return Boolean(candidate.parent_id && parentKeys.has(candidate.parent_id))
}

export function formatCompactDate(dateString?: string | null) {
  if (!dateString) return ''
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}

export function getKnowledgeBaseDisplayName(kb?: ExternalKnowledgeBase | null) {
  return kb?.knowledge_base_name || kb?.knowledge_base_id || ''
}

export function getOwnerLabel(item: {
  owner_name?: string | null
  owner_id?: string | null
  employee_id?: string | null
}) {
  const name = item.owner_name || item.owner_id || ''
  if (name && item.employee_id) return `${name}(${item.employee_id})`
  return name || item.employee_id || ''
}

export function flattenNodes(nodes: ExternalKbNode[]): ExternalKbNode[] {
  const result: ExternalKbNode[] = []
  const visit = (node: ExternalKbNode) => {
    result.push(node)
    node.children?.forEach(visit)
  }
  nodes.forEach(visit)
  return result
}
