// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * GroupSelector component
 * A dropdown selector for choosing groups in resource management pages
 */

'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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

export function GroupSelector({ value, onChange, scope = 'all' }: GroupSelectorProps) {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (scope === 'group' || scope === 'all') {
      loadGroups()
    }
  }, [scope])

  const loadGroups = async () => {
    try {
      setLoading(true)
      const response = await listGroups({ page: 1, limit: 100 })
      setGroups(response.items || [])
    } catch (error) {
      console.error('Failed to load groups:', error)
    } finally {
      setLoading(false)
    }
  }

  if (scope === 'personal') {
    return null
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-text-primary">
        {t('resourceScope.selectGroup')}
      </label>
      <Select value={value || ''} onValueChange={(val) => onChange(val || null)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={loading ? t('actions.loading') : t('resourceScope.selectGroup')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">{t('resourceScope.personal')}</SelectItem>
          {groups.map((group) => (
            <SelectItem key={group.id} value={group.name}>
              {group.display_name || group.name}
              {group.my_role && ` (${t(`groups.roles.${group.my_role}`)})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
