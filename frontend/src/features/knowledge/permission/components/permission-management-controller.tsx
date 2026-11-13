// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import client from '@/apis/client'
import type { MemberRole } from '@/types/knowledge'
import { useUser } from '@/features/common/UserContext'
import { useKnowledgePermissions } from '../hooks/useKnowledgePermissions'

export interface PermissionManagementProps {
  kbId: number
  kbNamespace?: string
  refreshKey?: number
  onChanged?: () => void
  onAccessDenied?: () => void
  canManage?: boolean
}

export interface PermissionManagementSessionProps extends PermissionManagementProps {
  isCurrentUi: () => boolean
}

/** Preserve owner notifications after UI closure while rejecting obsolete scopes. */
export function PermissionManagementScope({
  children,
  ...props
}: PermissionManagementProps & {
  children: (session: PermissionManagementSessionProps) => ReactNode
}) {
  const { user } = useUser()
  const cacheScope = client.getCacheScope()
  const scope = JSON.stringify([user?.id, cacheScope, props.kbId, props.kbNamespace])
  const activeScope = useRef({ key: scope, version: 0 })
  if (activeScope.current.key !== scope)
    activeScope.current = { key: scope, version: activeScope.current.version + 1 }
  const version = activeScope.current.version
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const sameScope = () =>
    activeScope.current.version === version && client.getCacheScope() === cacheScope
  const current = () => alive.current && sameScope()
  return (
    <Fragment key={scope}>
      {children({
        ...props,
        isCurrentUi: current,
        onChanged: () => {
          if (sameScope()) props.onChanged?.()
        },
        onAccessDenied: () => {
          if (current()) props.onAccessDenied?.()
        },
      })}
    </Fragment>
  )
}

/** The same member reads and mutation refresh contract serve both presentations. */
export function usePermissionManagementController(props: PermissionManagementSessionProps) {
  const [approvalRoles, setApprovalRoles] = useState<Record<number, MemberRole>>({})
  const setApprovalRole = (id: number, role: MemberRole) =>
    setApprovalRoles(prev => ({ ...prev, [id]: role }))
  const actions = useKnowledgePermissions({
    kbId: props.kbId,
    includePendingRequests: props.canManage !== false,
    onChanged: props.onChanged,
    onAccessDenied: props.onAccessDenied,
  })
  const { fetchPermissions } = actions
  useEffect(() => {
    void fetchPermissions()
  }, [fetchPermissions, props.refreshKey])
  const membersChanged = () => {
    props.onChanged?.()
    if (props.isCurrentUi()) void fetchPermissions()
  }
  return { ...actions, membersChanged, approvalRoles, setApprovalRole }
}
