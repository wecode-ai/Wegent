// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useEffect, useRef } from 'react'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { useTranslation } from '@/hooks/useTranslation'
import type { MemberRole } from '@/types/knowledge'
import { fetchCollaborators, updateCollaboratorRole, removeCollaborator } from '../api'
import type { CollaboratorInfo } from '../types'
import { sortCollaborators, parseCollaboratorDisplayName } from '../utils'

interface UseCollaboratorsReturn {
  collaborators: CollaboratorInfo[]
  loading: boolean
  error: string | null
  searchQuery: string
  setSearchQuery: (q: string) => void
  filteredCollaborators: CollaboratorInfo[]
  groupedCollaborators: Record<string, CollaboratorInfo[]>
  refresh: () => Promise<void>
  updateRole: (id: number, role: MemberRole) => Promise<void>
  remove: (id: number) => Promise<void>
  myRole: MemberRole | null
}

export function useCollaborators(kbId: number): UseCollaboratorsReturn {
  const { t } = useTranslation('knowledge')
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [myRole, setMyRole] = useState<MemberRole | null>(null)
  const kbIdRef = useRef(kbId)
  kbIdRef.current = kbId

  const fetchData = useCallback(async () => {
    const id = kbIdRef.current
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const [members, myPerm] = await Promise.all([
        fetchCollaborators(id),
        knowledgePermissionApi.getMyPermission(id).catch(() => null),
      ])

      const sorted = sortCollaborators(
        members.map((m): CollaboratorInfo => {
          const parsed = parseCollaboratorDisplayName(
            m.display_name ||
              m.entity_display_name ||
              (m.entity_type !== 'user' ? m.entity_id || '' : '')
          )
          return {
            id: m.id,
            display_name: parsed.name,
            added_by_name: m.invited_by_user_name || '',
            role: (m.role as MemberRole) || 'Reporter',
            entity_type: (m.entity_type || 'user') as CollaboratorInfo['entity_type'],
            entity_id: m.entity_id || undefined,
            requested_at: m.requested_at,
            employee_id: parsed.employeeId,
          }
        })
      )

      setCollaborators(sorted)
      setMyRole(myPerm?.role || null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch permissions'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (kbId) {
      fetchData()
    }
  }, [kbId, fetchData])

  const refresh = useCallback(async () => {
    await fetchData()
  }, [fetchData])

  const updateRole = useCallback(
    async (id: number, role: MemberRole) => {
      try {
        await updateCollaboratorRole(kbId, id, role)
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : t('document.permission.roleUpdateFailed')
        setError(message)
        throw err
      }
    },
    [kbId, refresh] // eslint-disable-line react-hooks/exhaustive-deps -- error message uses t, stable enough
  )

  const remove = useCallback(
    async (id: number) => {
      try {
        await removeCollaborator(kbId, id)
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : t('document.permission.removeFailed')
        setError(message)
        throw err
      }
    },
    [kbId, refresh] // eslint-disable-line react-hooks/exhaustive-deps -- error message uses t, stable enough
  )

  const filteredCollaborators = searchQuery
    ? collaborators.filter(
        c =>
          c.display_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.added_by_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.employee_id?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : collaborators

  // Group by entity_type: user → namespace → org_department
  const groupedCollaborators: Record<string, CollaboratorInfo[]> = {}
  filteredCollaborators.forEach(c => {
    const group = c.entity_type
    if (!groupedCollaborators[group]) groupedCollaborators[group] = []
    groupedCollaborators[group].push(c)
  })

  return {
    collaborators,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    filteredCollaborators,
    groupedCollaborators,
    refresh,
    updateRole,
    remove,
    myRole,
  }
}
