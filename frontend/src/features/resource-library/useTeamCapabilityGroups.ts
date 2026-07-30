// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'

import { listGroups } from '@/apis/groups'
import type { Group } from '@/types/group'

export interface TeamGroupSelection {
  all: boolean
  groupNames: string[]
}

export type TeamGroupStatus = 'loading' | 'ready' | 'error'

interface UseTeamCapabilityGroupsOptions {
  enabled?: boolean
  initialGroupName?: string
}

export function useTeamCapabilityGroups({
  enabled = true,
  initialGroupName,
}: UseTeamCapabilityGroupsOptions = {}) {
  const [groups, setGroups] = useState<Group[]>([])
  const [selection, setSelection] = useState<TeamGroupSelection>(() =>
    initialGroupName
      ? { all: false, groupNames: [initialGroupName] }
      : { all: true, groupNames: [] }
  )
  const [status, setStatus] = useState<TeamGroupStatus>('loading')

  const reload = useCallback(async () => {
    setStatus('loading')
    try {
      const response = await listGroups({ page: 1, limit: 100 })
      setGroups(response.items)
      setSelection(current => {
        if (current.all) return current

        const availableNames = new Set(response.items.map(group => group.name))
        const availableSelection = current.groupNames.filter(groupName =>
          availableNames.has(groupName)
        )

        return availableSelection.length > 0
          ? { all: false, groupNames: availableSelection }
          : { all: true, groupNames: [] }
      })
      setStatus('ready')
    } catch {
      setGroups([])
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    if (enabled) void reload()
  }, [enabled, reload])

  useEffect(() => {
    if (initialGroupName) {
      setSelection({ all: false, groupNames: [initialGroupName] })
    }
  }, [initialGroupName])

  return {
    groups,
    selection,
    setSelection,
    status,
    reload,
  }
}
