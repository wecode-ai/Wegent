// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isEditor, isManager, type BaseRole } from '@/types/base-role'
import type { Group } from '@/types/group'
import type { KnowledgeBase, MemberRole } from '@/types/knowledge'

export type NamespaceRoleMap = Map<string, BaseRole>

interface NamespaceAccessOptions {
  isAdmin?: boolean
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
  isAdmin = false,
}: NamespaceAccessOptions & { namespace: string }): boolean {
  if (namespace === 'default') {
    return true
  }

  if (isAdmin) {
    return true
  }

  return isEditor(namespaceRole)
}

export function canManageKnowledgeBase({
  currentUserId,
  knowledgeBase,
  knowledgeRole,
  namespaceRole,
  isAdmin = false,
}: KnowledgeAccessOptions): boolean {
  if (!currentUserId) {
    return false
  }

  if (isAdmin) {
    return true
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
  isAdmin = false,
}: KnowledgeAccessOptions): boolean {
  if (!currentUserId) {
    return false
  }

  if (isAdmin) {
    return true
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
  isAdmin = false,
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
      isAdmin,
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
      isAdmin,
    }) && documentOwnerId === currentUserId
  )
}

export function canManageKnowledgeBasePermissions({
  currentUserId,
  knowledgeBase,
  knowledgeRole,
  namespaceRole,
  isAdmin = false,
}: KnowledgeAccessOptions): boolean {
  if (!currentUserId) {
    return false
  }

  if (isAdmin) {
    return true
  }

  if (knowledgeBase.user_id === currentUserId) {
    return true
  }

  return isManager(namespaceRole) || isManager(knowledgeRole)
}

export function canManageNamespace({
  namespaceRole,
  isAdmin = false,
}: NamespaceAccessOptions): boolean {
  if (isAdmin) {
    return true
  }

  return namespaceRole === 'Owner'
}
