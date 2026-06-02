// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, type ReactNode } from 'react'
import TeamList from './TeamList'
import { GroupSelector } from './groups/GroupSelector'
import { listGroups } from '@/apis/groups'
import type { ResourceLibraryPublishSource } from '@/features/resource-library/types'
import type { BaseRole } from '@/types/base-role'
import type { Group } from '@/types/group'
import type { ManagedResourceSourceFilter } from '@/features/resource-library/types'

interface TeamListWithScopeProps {
  scope: 'personal' | 'group' | 'all'
  selectedGroup?: string | null
  onGroupChange?: (groupName: string | null) => void
  onPublishResource?: (source: ResourceLibraryPublishSource) => void
  sourceControls?: ReactNode
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
}

export function TeamListWithScope({
  scope,
  selectedGroup: externalSelectedGroup,
  onGroupChange,
  onPublishResource,
  sourceControls,
  sourceFilter,
  groups: externalGroups,
}: TeamListWithScopeProps) {
  // Use external state if provided, otherwise use internal state
  const [internalSelectedGroup, setInternalSelectedGroup] = useState<string | null>(null)
  const [groupRoleMap, setGroupRoleMap] = useState<Map<string, BaseRole>>(new Map())
  const [internalGroups, setInternalGroups] = useState<Group[]>([])
  const groups = externalGroups ?? internalGroups

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
        const roleMap = new Map<string, BaseRole>()
        response.items.forEach(group => {
          if (group.my_role) {
            roleMap.set(group.name, group.my_role)
          }
        })
        setInternalGroups(response.items || [])
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
    return (
      <TeamList
        scope="personal"
        onPublishResource={onPublishResource}
        sourceControls={sourceControls}
        sourceFilter={sourceFilter}
        groups={groups}
      />
    )
  }

  if (scope === 'all') {
    return (
      <TeamList
        scope="all"
        groupRoleMap={groupRoleMap}
        onPublishResource={onPublishResource}
        sourceControls={sourceControls}
        sourceFilter={sourceFilter}
        groups={groups}
      />
    )
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
      <TeamList
        scope="group"
        groupName={selectedGroup || undefined}
        groupRoleMap={groupRoleMap}
        onEditResource={handleEditResource}
        onPublishResource={onPublishResource}
        sourceControls={sourceControls}
        sourceFilter={sourceFilter}
        groups={groups}
      />
    </div>
  )
}
