// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import RetrieverList from './RetrieverList'
import { GroupSelector } from './groups/GroupSelector'
import { listGroups } from '@/apis/groups'
import type { GroupRole } from '@/types/group'

interface RetrieverListWithScopeProps {
  scope: 'personal' | 'group' | 'all'
  selectedGroup?: string | null
  onGroupChange?: (groupName: string | null) => void
}

export function RetrieverListWithScope({
  scope,
  selectedGroup: externalSelectedGroup,
  onGroupChange,
}: RetrieverListWithScopeProps) {
  // Use external state if provided, otherwise use internal state
  const [internalSelectedGroup, setInternalSelectedGroup] = useState<string | null>(null)
  const [groupRoleMap, setGroupRoleMap] = useState<Map<string, GroupRole>>(new Map())

  const selectedGroup =
    externalSelectedGroup !== undefined ? externalSelectedGroup : internalSelectedGroup
  const setSelectedGroup = onGroupChange || setInternalSelectedGroup

  // Sync internal state with external state
  useEffect(() => {
    if (externalSelectedGroup !== undefined && externalSelectedGroup !== internalSelectedGroup) {
      setInternalSelectedGroup(externalSelectedGroup)
    }
  }, [externalSelectedGroup, internalSelectedGroup])

  // Fetch all groups and build role map
  useEffect(() => {
    listGroups()
      .then(response => {
        const roleMap = new Map<string, GroupRole>()
        response.items.forEach(group => {
          if (group.my_role) {
            roleMap.set(group.name, group.my_role)
          }
        })
        setGroupRoleMap(roleMap)
      })
      .catch(error => {
        console.error('Failed to fetch groups:', error)
      })
  }, [])

  // Handle editing a resource - auto-select its group
  const handleEditResource = (namespace: string) => {
    if (namespace && namespace !== 'default') {
      setSelectedGroup(namespace)
    }
  }

  if (scope === 'personal') {
    return <RetrieverList scope="personal" />
  }

  // When selectedGroup is provided externally (from nav), don't show GroupSelector
  const showGroupSelector = externalSelectedGroup === undefined

  return (
    <div className="space-y-4">
      {scope === 'group' && showGroupSelector && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <GroupSelector value={selectedGroup} onChange={setSelectedGroup} scope={scope} />
        </div>
      )}
      <RetrieverList
        scope="group"
        groupName={selectedGroup || undefined}
        groupRoleMap={groupRoleMap}
        onEditResource={handleEditResource}
      />
    </div>
  )
}
