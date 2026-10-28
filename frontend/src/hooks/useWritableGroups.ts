// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { listGroups } from '@/apis/groups'
import { canEditContent } from '@/types/base-role'
import type { Group } from '@/types/group'

interface UseWritableGroupsResult {
  groups: Group[]
  loading: boolean
  error: Error | null
  reload: () => Promise<void>
}

const GROUP_PAGE_SIZE = 100

/**
 * Load the groups where the current user can create or edit resources.
 *
 * Sharing dialogs may be rendered outside the resource library, so they cannot
 * rely on a parent that already loaded the group list.
 */
export function useWritableGroups(enabled = true): UseWritableGroupsResult {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const loadedRef = useRef(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const firstPage = await listGroups({ page: 1, limit: GROUP_PAGE_SIZE })
      const allGroups = [...(firstPage.items || [])]
      const total = Math.max(firstPage.total ?? allGroups.length, allGroups.length)
      const pageCount = Math.ceil(total / GROUP_PAGE_SIZE)

      for (let page = 2; page <= pageCount; page += 1) {
        const response = await listGroups({ page, limit: GROUP_PAGE_SIZE })
        const items = response.items || []
        allGroups.push(...items)
        if (items.length === 0) break
      }

      setGroups(allGroups.filter(group => canEditContent(group.my_role)))
      loadedRef.current = true
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Failed to load groups'))
      loadedRef.current = false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      loadedRef.current = false
      return
    }
    if (!loadedRef.current) {
      void reload()
    }
  }, [enabled, reload])

  return { groups, loading, error, reload }
}
