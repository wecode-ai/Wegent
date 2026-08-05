// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, type ReactNode } from 'react'
import TeamList from './TeamList'
import { GroupSelector } from './groups/GroupSelector'
import { listGroups } from '@/apis/groups'
import type { BaseRole } from '@/types/base-role'
import type { Group } from '@/types/group'
import type { ManagedResourceSourceFilter } from '@/features/resource-library/types'
import type { ResourceLibrarySortMode } from '@/features/resource-library/resourceSorting'
import type { ResourceCreateRequest } from '@/features/resource-library/components/ResourceCreateButton'
import type { Team } from '@/types/api'
import type { TeamModeFilter } from '@/features/tasks/components/selector/team-selector-utils'

interface TeamListWithScopeProps {
  scope: 'personal' | 'group' | 'all'
  selectedGroup?: string | null
  onGroupChange?: (groupName: string | null) => void
  sourceControls?: ReactNode
  sortControls?: ReactNode
  sourceFilter?: ManagedResourceSourceFilter
  groups?: Group[]
  groupFilter?: string[]
  sortMode?: ResourceLibrarySortMode
  modeFilter?: TeamModeFilter
  onModeFilterChange?: (mode: TeamModeFilter) => void
  hideModeFilter?: boolean
  createRequest?: ResourceCreateRequest
  onCreated?: (team: Team) => void
  onCreateRequestClose?: () => void
  creationOnly?: boolean
  compact?: boolean
  hideCreateActions?: boolean
  searchQuery?: string
}

export function TeamListWithScope({
  scope,
  selectedGroup: externalSelectedGroup,
  onGroupChange,
  sourceControls,
  sortControls,
  sourceFilter,
  groups: externalGroups,
  groupFilter,
  sortMode = 'default',
  modeFilter,
  onModeFilterChange,
  hideModeFilter = false,
  createRequest,
  onCreated,
  onCreateRequestClose,
  creationOnly = false,
  compact = false,
  hideCreateActions = false,
  searchQuery = '',
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
        sourceControls={sourceControls}
        sortControls={sortControls}
        sourceFilter={sourceFilter}
        groups={groups}
        groupFilter={groupFilter}
        sortMode={sortMode}
        modeFilter={modeFilter}
        onModeFilterChange={onModeFilterChange}
        hideModeFilter={hideModeFilter}
        createRequest={createRequest}
        onCreated={onCreated}
        onCreateRequestClose={onCreateRequestClose}
        creationOnly={creationOnly}
        compact={compact}
        hideCreateActions={hideCreateActions}
        searchQuery={searchQuery}
      />
    )
  }

  if (scope === 'all') {
    return (
      <TeamList
        scope="all"
        groupRoleMap={groupRoleMap}
        sourceControls={sourceControls}
        sortControls={sortControls}
        sourceFilter={sourceFilter}
        groups={groups}
        groupFilter={groupFilter}
        sortMode={sortMode}
        modeFilter={modeFilter}
        onModeFilterChange={onModeFilterChange}
        hideModeFilter={hideModeFilter}
        createRequest={createRequest}
        onCreated={onCreated}
        onCreateRequestClose={onCreateRequestClose}
        creationOnly={creationOnly}
        compact={compact}
        hideCreateActions={hideCreateActions}
        searchQuery={searchQuery}
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
        sourceControls={sourceControls}
        sortControls={sortControls}
        sourceFilter={sourceFilter}
        groups={groups}
        groupFilter={groupFilter}
        sortMode={sortMode}
        modeFilter={modeFilter}
        onModeFilterChange={onModeFilterChange}
        hideModeFilter={hideModeFilter}
        createRequest={createRequest}
        onCreated={onCreated}
        onCreateRequestClose={onCreateRequestClose}
        creationOnly={creationOnly}
        compact={compact}
        hideCreateActions={hideCreateActions}
        searchQuery={searchQuery}
      />
    </div>
  )
}
