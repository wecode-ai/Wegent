// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isEditor, isManager, type BaseRole } from '@/types/base-role'
import type { Group } from '@/types/group'
import type { KnowledgeBase, MemberRole } from '@/types/knowledge'

export type NamespaceRoleMap = Map<string, BaseRole>

interface NamespaceAccessOptions {
  namespaceRole?: BaseRole | null
}

interface KnowledgeAccessOptions extends NamespaceAccessOptions {
  currentUserId?: number | null
  knowledgeBase: Pick<KnowledgeBase, 'namespace' | 'user_id'>
  knowledgeRole?: MemberRole | null
}

export function buildNamespaceRoleMap(
  groups: Array<Pick<Group, 'name' | 'my_role'>>
): NamespaceRoleMap {
  const roleMap: NamespaceRoleMap = new Map()

  groups.forEach(group => {
    if (group.my_role) {
      roleMap.set(group.name, group.my_role)
    }
  })

  return roleMap
}

export function canCreateKnowledgeBaseInNamespace({
  namespace,
  namespaceRole,
}: NamespaceAccessOptions & { namespace: string }): boolean {
  if (namespace === 'default') {
    return true
  }

  return isEditor(namespaceRole)
}

export function canManageKnowledgeBase({
  currentUserId,
  knowledgeBase,
  knowledgeRole,
  namespaceRole,
}: KnowledgeAccessOptions): boolean {
  if (!currentUserId) {
    return false
  }

  if (knowledgeBase.namespace === 'default') {
    return knowledgeBase.user_id === currentUserId || isManager(knowledgeRole)
  }

  if (isManager(namespaceRole) || isManager(knowledgeRole)) {
    return true
  }

  return (
    (isEditor(namespaceRole) || isEditor(knowledgeRole)) && knowledgeBase.user_id === currentUserId
  )
}

export function canManageKnowledgeBaseDocuments({
  currentUserId,
  knowledgeBase,
  knowledgeRole,
  namespaceRole,
}: KnowledgeAccessOptions): boolean {
  if (!currentUserId) {
    return false
  }

  if (knowledgeBase.namespace === 'default') {
    return knowledgeBase.user_id === currentUserId || isEditor(knowledgeRole)
  }

  return isEditor(namespaceRole) || isEditor(knowledgeRole)
}

export function canManageKnowledgeDocument({
  currentUserId,
  knowledgeBase,
  knowledgeRole,
  namespaceRole,
  documentOwnerId,
}: KnowledgeAccessOptions & { documentOwnerId: number | null | undefined }): boolean {
  if (!currentUserId) {
    return false
  }

  if (
    canManageKnowledgeBase({
      currentUserId,
      knowledgeBase,
      knowledgeRole,
      namespaceRole,
    })
  ) {
    return true
  }

  if (documentOwnerId == null) {
    return false
  }

  return (
    canManageKnowledgeBaseDocuments({
      currentUserId,
      knowledgeBase,
      knowledgeRole,
      namespaceRole,
    }) && documentOwnerId === currentUserId
  )
}

export function canManageKnowledgeBasePermissions({
  currentUserId,
  knowledgeBase,
  knowledgeRole,
  namespaceRole,
}: KnowledgeAccessOptions): boolean {
  if (!currentUserId) {
    return false
  }

  if (knowledgeBase.user_id === currentUserId) {
    return true
  }

  return isManager(namespaceRole) || isManager(knowledgeRole)
}

export function canManageNamespace({ namespaceRole }: NamespaceAccessOptions): boolean {
  return namespaceRole === 'Owner'
}
