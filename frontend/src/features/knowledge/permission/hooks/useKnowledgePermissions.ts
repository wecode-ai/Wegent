// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import type {
  KBShareInfo,
  MyPermissionResponse,
  PermissionAddRequest,
  PermissionApplyRequest,
  PermissionApplyResponse,
  PermissionLevel,
  PermissionListResponse,
  PermissionResponse,
  PermissionReviewRequest,
  PermissionReviewResponse,
  ReviewAction,
} from '@/types/knowledge'

interface UseKnowledgePermissionsOptions {
  kbId: number
}

interface UseKnowledgePermissionsReturn {
  // State
  permissions: PermissionListResponse | null
  myPermission: MyPermissionResponse | null
  shareInfo: KBShareInfo | null
  loading: boolean
  error: string | null

  // Actions
  fetchPermissions: () => Promise<void>
  fetchMyPermission: () => Promise<void>
  fetchShareInfo: () => Promise<void>
  applyPermission: (level: PermissionLevel) => Promise<PermissionApplyResponse>
  reviewPermission: (
    permissionId: number,
    action: ReviewAction,
    level?: PermissionLevel
  ) => Promise<PermissionReviewResponse>
  addPermission: (userName: string, level: PermissionLevel) => Promise<PermissionResponse>
  updatePermission: (permissionId: number, level: PermissionLevel) => Promise<PermissionResponse>
  deletePermission: (permissionId: number) => Promise<void>
  clearError: () => void
}

export function useKnowledgePermissions({
  kbId,
}: UseKnowledgePermissionsOptions): UseKnowledgePermissionsReturn {
  const [permissions, setPermissions] = useState<PermissionListResponse | null>(null)
  const [myPermission, setMyPermission] = useState<MyPermissionResponse | null>(null)
  const [shareInfo, setShareInfo] = useState<KBShareInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchPermissions = useCallback(async () => {
    if (!kbId) return
    setLoading(true)
    setError(null)
    try {
      const result = await knowledgePermissionApi.listPermissions(kbId)
      setPermissions(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch permissions'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [kbId])

  const fetchMyPermission = useCallback(async () => {
    if (!kbId) return
    setLoading(true)
    setError(null)
    try {
      const result = await knowledgePermissionApi.getMyPermission(kbId)
      setMyPermission(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch permission'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [kbId])

  const fetchShareInfo = useCallback(async () => {
    if (!kbId) return
    setLoading(true)
    setError(null)
    try {
      const result = await knowledgePermissionApi.getShareInfo(kbId)
      setShareInfo(result)
      setMyPermission(result.my_permission)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch share info'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [kbId])

  const applyPermission = useCallback(
    async (level: PermissionLevel): Promise<PermissionApplyResponse> => {
      setLoading(true)
      setError(null)
      try {
        const request: PermissionApplyRequest = { permission_level: level }
        const result = await knowledgePermissionApi.applyPermission(kbId, request)
        // Refresh my permission after applying
        await fetchMyPermission()
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to apply permission'
        setError(message)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [kbId, fetchMyPermission]
  )

  const reviewPermission = useCallback(
    async (
      permissionId: number,
      action: ReviewAction,
      level?: PermissionLevel
    ): Promise<PermissionReviewResponse> => {
      setLoading(true)
      setError(null)
      try {
        const request: PermissionReviewRequest = {
          action,
          permission_level: level,
        }
        const result = await knowledgePermissionApi.reviewPermission(kbId, permissionId, request)
        // Refresh permissions after review
        await fetchPermissions()
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to review permission'
        setError(message)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [kbId, fetchPermissions]
  )

  const addPermission = useCallback(
    async (userName: string, level: PermissionLevel): Promise<PermissionResponse> => {
      setLoading(true)
      setError(null)
      try {
        const request: PermissionAddRequest = {
          user_name: userName,
          permission_level: level,
        }
        const result = await knowledgePermissionApi.addPermission(kbId, request)
        // Refresh permissions after adding
        await fetchPermissions()
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add permission'
        setError(message)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [kbId, fetchPermissions]
  )

  const updatePermission = useCallback(
    async (permissionId: number, level: PermissionLevel): Promise<PermissionResponse> => {
      setLoading(true)
      setError(null)
      try {
        const result = await knowledgePermissionApi.updatePermission(kbId, permissionId, {
          permission_level: level,
        })
        // Refresh permissions after update
        await fetchPermissions()
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update permission'
        setError(message)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [kbId, fetchPermissions]
  )

  const deletePermission = useCallback(
    async (permissionId: number): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        await knowledgePermissionApi.deletePermission(kbId, permissionId)
        // Refresh permissions after delete
        await fetchPermissions()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete permission'
        setError(message)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [kbId, fetchPermissions]
  )

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    permissions,
    myPermission,
    shareInfo,
    loading,
    error,
    fetchPermissions,
    fetchMyPermission,
    fetchShareInfo,
    applyPermission,
    reviewPermission,
    addPermission,
    updatePermission,
    deletePermission,
    clearError,
  }
}
