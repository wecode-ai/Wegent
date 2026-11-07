// SPDX-FileCopyrightText: 2025 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import client, { ApiError } from '@/apis/client'
import { useUser } from '@/features/common/UserContext'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import type {
  KBShareInfo,
  MemberRole,
  MyPermissionResponse,
  PermissionListResponse,
  ReviewAction,
} from '@/types/knowledge'

interface UseKnowledgePermissionsOptions {
  kbId: number
  includePendingRequests?: boolean
  onChanged?: () => void
  onAccessDenied?: () => void
}
interface PermissionState {
  permissions: PermissionListResponse | null
  myPermission: MyPermissionResponse | null
  shareInfo: KBShareInfo | null
  loading: boolean
  error: string | null
}
const emptyState: PermissionState = {
  permissions: null,
  myPermission: null,
  shareInfo: null,
  loading: false,
  error: null,
}

export function useKnowledgePermissions(options: UseKnowledgePermissionsOptions) {
  const { kbId, includePendingRequests = false } = options
  const { user } = useUser()
  const cacheScope = client.getCacheScope()
  const scope = JSON.stringify([user?.id, cacheScope, kbId])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const callbacks = useRef(options)
  callbacks.current = options
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const generation = useRef(0)
  const [stateScope, setStateScope] = useState(scope)
  const [state, setState] = useState(emptyState)
  const reads = useRef<Record<string, number>>({})
  const pending = useRef(0)
  if (stateScope !== scope) {
    generation.current++
    setStateScope(scope)
    setState(emptyState)
    pending.current = 0
    reads.current = {}
  }

  const currentGeneration = generation.current

  const run = useCallback(
    async <T>(
      operation: () => Promise<T>,
      apply?: (value: T) => void,
      fresh: () => boolean = () => true
    ): Promise<T> => {
      const current = () =>
        mounted.current &&
        scopeRef.current === scope &&
        generation.current === currentGeneration &&
        client.getCacheScope() === cacheScope
      if (!current()) throw new Error('Permission session changed')
      pending.current++
      setState(prev => ({ ...prev, loading: true, error: null }))
      try {
        const value = await operation()
        if (current() && fresh()) apply?.(value)
        return value
      } catch (error) {
        if (current() && fresh()) {
          setState(prev => ({
            ...prev,
            error: error instanceof Error ? error.message : String(error),
          }))
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
            setState(prev => ({ ...prev, permissions: null, myPermission: null, shareInfo: null }))
            callbacks.current.onAccessDenied?.()
          }
        }
        throw error
      } finally {
        if (current()) {
          pending.current--
          setState(prev => ({ ...prev, loading: pending.current > 0 }))
        }
      }
    },
    [scope, currentGeneration, cacheScope]
  )

  const read = useCallback(
    async <T>(key: string, operation: () => Promise<T>, apply: (value: T) => void) => {
      if (!kbId || scopeRef.current !== scope || generation.current !== currentGeneration) return
      const attempt = (reads.current[key] ?? 0) + 1
      reads.current[key] = attempt
      try {
        await run(operation, apply, () => reads.current[key] === attempt)
      } catch {
        /* Errors are exposed through this session's state. */
      }
    },
    [kbId, run, scope, currentGeneration]
  )

  const fetchPermissions = useCallback(
    () =>
      read(
        'members',
        () => knowledgePermissionApi.listPermissions(kbId, { includePendingRequests }),
        permissions => setState(prev => ({ ...prev, permissions }))
      ),
    [read, kbId, includePendingRequests]
  )
  const fetchMyPermission = useCallback(
    () =>
      read(
        'mine',
        () => knowledgePermissionApi.getMyPermission(kbId),
        myPermission => setState(prev => ({ ...prev, myPermission }))
      ),
    [read, kbId]
  )
  const fetchShareInfo = useCallback(
    () =>
      read(
        'share',
        () => knowledgePermissionApi.getShareInfo(kbId),
        shareInfo =>
          setState(prev => ({ ...prev, shareInfo, myPermission: shareInfo.my_permission }))
      ),
    [read, kbId]
  )

  const change = useCallback(
    async <T>(operation: () => Promise<T>, refresh: () => Promise<void>): Promise<T> => {
      const result = await run(operation)
      if (
        scopeRef.current === scope &&
        generation.current === currentGeneration &&
        client.getCacheScope() === cacheScope
      ) {
        // Invalidate the live owner even when the permission UI has closed.
        callbacks.current.onChanged?.()
        if (mounted.current) await refresh()
      }
      return result
    },
    [run, scope, currentGeneration, cacheScope]
  )
  const applyPermission = useCallback(
    (role: MemberRole) =>
      change(() => knowledgePermissionApi.applyPermission(kbId, { role }), fetchMyPermission),
    [change, kbId, fetchMyPermission]
  )
  const reviewPermission = useCallback(
    (id: number, action: ReviewAction, role?: MemberRole) =>
      change(
        () => knowledgePermissionApi.reviewPermission(kbId, id, { action, role }),
        fetchPermissions
      ),
    [change, kbId, fetchPermissions]
  )
  const addPermission = useCallback(
    (userName: string, role: MemberRole) =>
      change(
        () => knowledgePermissionApi.addPermission(kbId, { user_name: userName, role }),
        fetchPermissions
      ),
    [change, kbId, fetchPermissions]
  )
  const batchAddPermission = useCallback(
    (users: { user_id: number; role: MemberRole }[]) =>
      change(
        () => knowledgePermissionApi.batchAddPermission(kbId, { members: users }),
        fetchPermissions
      ),
    [change, kbId, fetchPermissions]
  )
  const updatePermission = useCallback(
    (id: number, role: MemberRole) =>
      change(() => knowledgePermissionApi.updatePermission(kbId, id, { role }), fetchPermissions),
    [change, kbId, fetchPermissions]
  )
  const deletePermission = useCallback(
    async (id: number): Promise<void> => {
      await change(() => knowledgePermissionApi.deletePermission(kbId, id), fetchPermissions)
    },
    [change, kbId, fetchPermissions]
  )
  const clearError = useCallback(() => {
    if (scopeRef.current === scope && generation.current === currentGeneration)
      setState(prev => ({ ...prev, error: null }))
  }, [scope, currentGeneration])

  return {
    ...state,
    fetchPermissions,
    fetchMyPermission,
    fetchShareInfo,
    applyPermission,
    reviewPermission,
    addPermission,
    batchAddPermission,
    updatePermission,
    deletePermission,
    clearError,
  }
}
