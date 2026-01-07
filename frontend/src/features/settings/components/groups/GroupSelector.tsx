// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * GroupSelector component
 * A dropdown selector for choosing groups in resource management pages
 */

'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { listGroups } from '@/apis/groups'
import type { Group } from '@/types/group'

interface GroupSelectorProps {
  value: string | null
  onChange: (value: string | null) => void
  scope?: 'personal' | 'group' | 'all'
}

const ALL_GROUPS_VALUE = '__all__'

export function GroupSelector({ value, onChange, scope = 'all' }: GroupSelectorProps) {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (scope === 'group' || scope === 'all') {
      loadGroups()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const loadGroups = async () => {
    try {
      setLoading(true)
      const response = await listGroups({ page: 1, limit: 100 })
      setGroups(response.items || [])
      // Set default to "all groups" if no value is set
      if (value === null && (response.items || []).length > 0) {
        onChange(null) // null means all groups
      }
    } catch (error) {
      console.error('Failed to load groups:', error)
    } finally {
      setLoading(false)
    }
  }

  if (scope === 'personal') {
    return null
  }

  // Convert between internal value (null for all groups) and Select value (special string)
  const selectValue = value === null ? ALL_GROUPS_VALUE : value
  const handleChange = (val: string) => {
    onChange(val === ALL_GROUPS_VALUE ? null : val)
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-text-primary">
        {t('groups:resourceScope.selectGroup')}
      </label>
      <Select value={selectValue} onValueChange={handleChange}>
        <SelectTrigger className="w-full">
          <SelectValue
            placeholder={
              loading ? t('common:actions.loading') : t('groups:resourceScope.selectGroup')
            }
          />
        </SelectTrigger>
        <SelectContent>
          {/* Add "All Groups" option */}
          <SelectItem value={ALL_GROUPS_VALUE}>{t('groups:resourceScope.allGroups')}</SelectItem>
          {groups.map(group => (
            <SelectItem key={group.id} value={group.name}>
              {group.display_name || group.name}
              {group.my_role && ` (${t(`groups:groups.roles.${group.my_role}`)})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
