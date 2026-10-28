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
  reload: () => Promise<void>
}

/**
 * Load the groups where the current user can create or edit resources.
 *
 * Sharing dialogs may be rendered outside the resource library, so they cannot
 * rely on a parent that already loaded the group list.
 */
export function useWritableGroups(enabled = true): UseWritableGroupsResult {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const loadedRef = useRef(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const response = await listGroups({ page: 1, limit: 100 })
      setGroups((response.items || []).filter(group => canEditContent(group.my_role)))
      loadedRef.current = true
    } catch {
      loadedRef.current = false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled && !loadedRef.current) {
      void reload()
    }
  }, [enabled, reload])

  return { groups, loading, reload }
}
