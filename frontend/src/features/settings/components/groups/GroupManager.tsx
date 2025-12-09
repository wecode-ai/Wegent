// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * GroupManager component
 * Basic group management interface - placeholder for full implementation
 *
 * TODO: Full implementation would include:
 * - Create/Edit group dialogs
 * - Member management modal
 * - Role assignment interface
 * - Transfer ownership flow
 * - Group settings panel
 */

'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { listGroups, deleteGroup } from '@/apis/groups'
import type { Group } from '@/types/group'
import { PlusIcon, PencilIcon, TrashIcon, UsersIcon } from 'lucide-react'
import { toast } from 'sonner'

export function GroupManager() {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadGroups()
  }, [])

  const loadGroups = async () => {
    try {
      setLoading(true)
      const response = await listGroups({ page: 1, limit: 100 })
      setGroups(response.items || [])
    } catch (error) {
      console.error('Failed to load groups:', error)
      toast.error('Failed to load groups')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (groupName: string) => {
    if (!confirm(t('groups.actions.delete') + '?')) {
      return
    }

    try {
      await deleteGroup(groupName)
      toast.success(t('groups.messages.deleteSuccess'))
      loadGroups()
    } catch (error) {
      console.error('Failed to delete group:', error)
      toast.error('Failed to delete group')
    }
  }

  const getVisibilityBadge = (visibility: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'outline'> = {
      private: 'default',
      internal: 'secondary',
      public: 'outline',
    }
    return (
      <Badge variant={variants[visibility] || 'default'}>
        {t(`groups.${visibility}`)}
      </Badge>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-text-secondary">{t('actions.loading')}</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">{t('groups.title')}</h2>
          <p className="text-sm text-text-secondary mt-1">
            Manage your groups and memberships
          </p>
        </div>
        <Button onClick={() => toast.info('Create group dialog - TODO')}>
          <PlusIcon className="w-4 h-4 mr-2" />
          {t('groups.create')}
        </Button>
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-12 bg-surface rounded-lg border border-border">
          <UsersIcon className="w-12 h-12 mx-auto text-text-muted mb-4" />
          <p className="text-text-secondary">No groups yet</p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => toast.info('Create group dialog - TODO')}
          >
            <PlusIcon className="w-4 h-4 mr-2" />
            {t('groups.create')}
          </Button>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted border-b border-border">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups.name')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups.displayName')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups.visibility')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups.myRole')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups.members')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups.resources')}
                  </th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-text-primary">
                    {t('actions.edit')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {groups.map((group) => (
                  <tr key={group.id} className="hover:bg-surface">
                    <td className="px-4 py-3 text-sm font-medium text-text-primary">
                      {group.name}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {group.display_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-sm">{getVisibilityBadge(group.visibility)}</td>
                    <td className="px-4 py-3 text-sm">
                      {group.my_role ? (
                        <Badge variant="outline">{t(`groups.roles.${group.my_role}`)}</Badge>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {group.member_count || 0}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {group.resource_count || 0}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toast.info('Edit group dialog - TODO')}
                        >
                          <PencilIcon className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toast.info('Member management - TODO')}
                        >
                          <UsersIcon className="w-4 h-4" />
                        </Button>
                        {group.my_role === 'Owner' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(group.name)}
                          >
                            <TrashIcon className="w-4 h-4 text-red-500" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="text-sm text-text-muted bg-surface p-4 rounded-lg border border-border">
        <p className="font-medium mb-2">Note:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>This is a basic placeholder implementation</li>
          <li>Full features would include: create/edit dialogs, member management, settings</li>
          <li>Click buttons to see TODOs for future enhancements</li>
        </ul>
      </div>
    </div>
  )
}
