// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import ModelList from './ModelList'
import { GroupSelector } from './groups/GroupSelector'
import { listGroups } from '@/apis/groups'
import type { GroupRole } from '@/types/group'

interface ModelListWithScopeProps {
  scope: 'personal' | 'group' | 'all'
}

export function ModelListWithScope({ scope }: ModelListWithScopeProps) {
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const [groupRoleMap, setGroupRoleMap] = useState<Map<string, GroupRole>>(new Map())

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
    return <ModelList scope="personal" />
  }

  return (
    <div className="space-y-4">
      {scope === 'group' && (
        <div className="bg-surface border border-border rounded-lg p-4">
          <GroupSelector
            value={selectedGroup}
            onChange={setSelectedGroup}
            scope={scope}
          />
        </div>
      )}
      <ModelList
        scope="group"
        groupName={selectedGroup || undefined}
        groupRoleMap={groupRoleMap}
        onEditResource={handleEditResource}
      />
    </div>
  )
}